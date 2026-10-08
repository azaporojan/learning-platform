// ---------------------------------------------------------------------------
// Password policy and hashing — the only place that touches password hashes.
//
// Goal: a copy of the database (a dump, a backup, an SQL injection) must not reveal passwords.
//
//   1. Hash: scrypt (memory-hard: 64 MiB and ~0.3 s per guess, N=2^16 r=8 p=2 — OWASP's
//      equivalent of N=2^17 p=1), random 16-byte salt. Older bcrypt hashes still verify and are
//      replaced by scrypt on the user's next successful login.
//   2. Seal: every stored hash is encrypted with AES-256-GCM under PASSWORD_PEPPER, a key that
//      lives only in the server environment, never in the database or its backups. Without the
//      key a stolen hash cannot even be attacked offline: there is nothing to guess against.
//      If the key leaks too, step 1 still makes every guess expensive.
//      The stored value is  $sealed$v1$<key id>$<iv>$<ciphertext+tag>  (base64url).
//      Keys rotate: put the old key in PASSWORD_PEPPER_PREVIOUS and a new one in PASSWORD_PEPPER;
//      sealAllPasswords() (run at startup) re-seals every row with the new key.
//   3. Emailed login codes are stored as HMAC(PASSWORD_PEPPER, code): a plain SHA-256 of a
//      6-digit code is reversed in a second.
//   - New passwords must be 8+ characters, not a well-known password, not built from the user's
//     email or name, and not present in a public breach (Have I Been Pwned, k-anonymity: only
//     the first 5 hex characters of the SHA-1 leave the server). The breach lookup fails open
//     (a network problem never blocks a signup); PASSWORD_BREACH_CHECK=false turns it off.
// ---------------------------------------------------------------------------
const bcrypt = require('bcrypt'); // only to verify hashes created before scrypt
const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT = { N: 2 ** 16, r: 8, p: 2, keylen: 32 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const MIN_LENGTH = 8;
const MAX_LENGTH = 256; // scrypt has no input limit; this only bounds the work per request

// ---- the pepper key(s) ------------------------------------------------------
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (str) => Buffer.from(str, 'base64url');

function parseKey(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const bytes = /^[0-9a-f]{64,}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (bytes.length < 32) throw new Error('PASSWORD_PEPPER must be at least 32 random bytes (base64 or hex)');
  const key = crypto.createHash('sha256').update(bytes).digest(); // normalise to 32 bytes
  const id = crypto.createHash('sha256').update('password-pepper-id').update(key).digest('hex').slice(0, 8);
  return { id, key };
}

let currentKey = null;
const keysById = new Map();

// Load PASSWORD_PEPPER (+ PASSWORD_PEPPER_PREVIOUS, comma-separated). Only an explicit
// NODE_ENV=development or test may fall back to a fixed, publicly known key (no protection) with a
// warning; anything else — production, staging, an unset NODE_ENV — refuses to run without it,
// so real hashes are never sealed with the public key.
const allowsDevKey = (env) => env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
function configure(env = process.env, { production = !allowsDevKey(env) } = {}) {
  keysById.clear();
  let current = parseKey(env.PASSWORD_PEPPER);
  if (!current) {
    if (production) throw new Error('PASSWORD_PEPPER must be set unless NODE_ENV is development or test (generate one with: openssl rand -base64 32)');
    console.warn('[Passwords] PASSWORD_PEPPER is not set — using an insecure development key. Never do this in production.');
    current = parseKey(Buffer.alloc(32, 7).toString('base64'));
  }
  currentKey = current;
  keysById.set(current.id, current);
  for (const raw of String(env.PASSWORD_PEPPER_PREVIOUS || '').split(',')) {
    const k = parseKey(raw);
    if (k) keysById.set(k.id, k);
  }
  return currentKey.id;
}

const key = () => { if (!currentKey) configure(); return currentKey; };

const SEAL_PREFIX = '$sealed$v1$';
const isSealed = (stored) => typeof stored === 'string' && stored.startsWith(SEAL_PREFIX);

function seal(innerHash) {
  const k = key();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k.key, iv);
  const ct = Buffer.concat([cipher.update(innerHash, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${SEAL_PREFIX}${k.id}$${b64u(iv)}$${b64u(ct)}`;
}

// The inner hash, or null when the value is malformed or sealed with a key we do not have.
function unseal(stored) {
  if (!isSealed(stored)) return null;
  const [kid, ivPart, ctPart] = stored.slice(SEAL_PREFIX.length).split('$');
  const k = keysById.get(kid) || (key().id === kid ? key() : null);
  if (!k || !ivPart || !ctPart) return null;
  try {
    const data = unb64u(ctPart);
    const decipher = crypto.createDecipheriv('aes-256-gcm', k.key, unb64u(ivPart));
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

const sealKeyId = (stored) => (isSealed(stored) ? stored.slice(SEAL_PREFIX.length).split('$')[0] : null);

// ---- scrypt -----------------------------------------------------------------
async function scryptHash(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scryptAsync(password.normalize('NFC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64u(salt)}$${b64u(dk)}`;
}

async function scryptVerify(password, inner) {
  const [, n, r, p, saltPart, hashPart] = inner.split('$');
  const expected = unb64u(hashPart || '');
  const dk = await scryptAsync(password.normalize('NFC'), unb64u(saltPart || ''), expected.length || SCRYPT.keylen, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM,
  });
  return expected.length > 0 && crypto.timingSafeEqual(dk, expected);
}

const isCurrentScrypt = (inner) => inner.startsWith(`scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$`);

// Compared against when the email does not exist, so a login takes as long whether or not
// the account exists (otherwise response time reveals which emails are registered).
let dummy = null;
const dummyInner = async () => (dummy ||= await scryptHash(crypto.randomBytes(16).toString('hex')));

// The most common passwords that pass a length check; the breach lookup catches the rest.
const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  '12345678', '123456789', '1234567890', '12345678910', '87654321', '11111111', '00000000', '11223344',
  '123123123', '1q2w3e4r', '1q2w3e4r5t', 'q1w2e3r4', 'qwertyui', 'qwerty123', 'qwerty1234', 'qwertyuiop',
  'asdfghjk', 'asdfghjkl', 'zxcvbnm1', 'iloveyou', 'iloveyou1', 'sunshine', 'princess', 'football',
  'baseball', 'superman', 'trustno1', 'welcome1', 'welcome123', 'letmein1', 'letmein123', 'admin123',
  'administrator', 'changeme', 'changeme123', 'abc12345', 'abcd1234', 'aa123456', 'monkey123', 'dragon123',
  'computer', 'internet', 'whatever', 'starwars', 'michael1', 'jennifer', 'charlie1', 'shadow123',
  'master123', 'mustang1', 'freedom1', 'qazwsxedc', '1qaz2wsx', 'zaq12wsx', 'test1234', 'testtest',
  'learning', 'learning1', 'learning123', 'student1', 'student123', 'qa123456', 'automation',
]);

const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Synchronous rules. Returns an error message, or null when the password is acceptable.
function passwordProblem(password, { email = '', name = '' } = {}) {
  if (typeof password !== 'string') return 'Password is required.';
  if (password.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters.`;
  if (password.length > MAX_LENGTH) return `Password is too long (max ${MAX_LENGTH} characters).`;
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[!.?]+$/, ''))) return 'This password is too common. Please choose another one.';
  if (/^(.)\1+$/.test(password)) return 'This password is too easy to guess. Please choose another one.';
  // "Your name or email + a few characters" (alex2024!, Maria123) is among the first guesses
  const p = normalize(password);
  const basedOn = (word) => word.length >= 3 && p.startsWith(word) && p.length - word.length <= 4;
  if (basedOn(normalize(String(email).split('@')[0]))) return 'Your password must not be based on your email address.';
  if (String(name).split(/\s+/).map(normalize).some(basedOn) || basedOn(normalize(name))) return 'Your password must not be based on your name.';
  return null;
}

// Times the password appears in known breaches, or null when the lookup was skipped / failed.
async function breachCount(password) {
  if (process.env.PASSWORD_BREACH_CHECK === 'false') return null;
  const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'learning-platform' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = await res.text();
    for (const line of body.split('\n')) {
      const [hash, count] = line.trim().split(':');
      if (hash === suffix) return parseInt(count, 10) || 0;
    }
    return 0;
  } catch (e) {
    console.warn('[Passwords] Breach check unavailable:', e.message || e);
    return null;
  }
}

// Full check for a new password: the rules above, then the breach lookup.
async function validateNewPassword(password, context) {
  const problem = passwordProblem(password, context);
  if (problem) return problem;
  const seen = await breachCount(password);
  if (seen && seen > 0) return 'This password has appeared in a public data breach. Please choose a different one.';
  return null;
}

// The value to store in users.password: a sealed scrypt hash.
const hashPassword = async (password) => seal(await scryptHash(password));

// { ok, needsRehash }. `stored` may be null (unknown user): the dummy hash keeps the timing equal.
// needsRehash = the password was right but the stored value is a legacy bcrypt hash, older scrypt
// parameters, unsealed, or sealed with a previous key — the caller stores hashPassword() again.
async function verifyPassword(password, stored) {
  const inner = stored ? (isSealed(stored) ? unseal(stored) : stored) : null;
  if (typeof password !== 'string' || password.length > MAX_LENGTH || !inner) {
    await scryptVerify('x', await dummyInner());
    if (stored && !inner) {
      console.error('[Passwords] A stored hash could not be unsealed: is PASSWORD_PEPPER (or _PREVIOUS) missing?');
      // Not the user's fault: callers must not count this as a wrong password
      return { ok: false, needsRehash: false, unreadable: true };
    }
    return { ok: false, needsRehash: false };
  }
  let ok = false;
  if (inner.startsWith('scrypt$')) ok = await scryptVerify(password, inner);
  else if (/^\$2[aby]\$/.test(inner)) ok = await bcrypt.compare(password, inner);
  if (!ok) return { ok: false, needsRehash: false };
  const needsRehash = !isCurrentScrypt(inner) || !isSealed(stored) || sealKeyId(stored) !== key().id;
  return { ok: true, needsRehash };
}

// Encrypt every stored hash that is not yet sealed with the current key (legacy bcrypt hashes,
// or hashes sealed with a PASSWORD_PEPPER_PREVIOUS key). Needs no password: the inner hash is
// sealed as it is, so a database copy taken after this runs holds no attackable hash at all.
async function sealAllPasswords(db) {
  const k = key();
  const [rows] = await db.query("SELECT id, password FROM users WHERE password NOT LIKE ?", [`${SEAL_PREFIX}${k.id}$%`]);
  let sealed = 0;
  let failed = 0;
  for (const row of rows) {
    const inner = isSealed(row.password) ? unseal(row.password) : row.password;
    if (!inner) { failed += 1; continue; }
    await db.query('UPDATE users SET password = ? WHERE id = ? AND password = ?', [seal(inner), row.id, row.password]);
    sealed += 1;
  }
  if (sealed > 0) console.log(`[Passwords] Sealed ${sealed} password hash(es) with key ${k.id}.`);
  if (failed > 0) console.error(`[Passwords] ${failed} password hash(es) are sealed with an unknown key: add it to PASSWORD_PEPPER_PREVIOUS.`);
  return { sealed, failed };
}

// Login codes are stored as an HMAC under the pepper, so a database copy does not expose live
// codes (a bare hash of a 6-digit number is reversed instantly).
const hashLoginCode = (code) => crypto.createHmac('sha256', key().key).update(`login-code:${code}`).digest('hex');
function loginCodeMatches(provided, storedHash) {
  if (typeof provided !== 'string' || typeof storedHash !== 'string') return false;
  const a = Buffer.from(hashLoginCode(provided));
  const b = Buffer.from(storedHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  configure, passwordProblem, validateNewPassword, breachCount, hashPassword, verifyPassword,
  sealAllPasswords, hashLoginCode, loginCodeMatches,
  _internals: { seal, unseal, isSealed, scryptHash, SCRYPT },
};
