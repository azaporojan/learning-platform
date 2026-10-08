// ---------------------------------------------------------------------------
// Password policy and hashing — the only place that touches password hashes.
//
//   - bcrypt, cost 12. Hashes made with a lower cost are upgraded on the next successful login.
//   - bcrypt only reads the first 72 bytes of its input, so longer passwords are refused instead
//     of being silently truncated (two passwords sharing those bytes would otherwise both work).
//   - New passwords must be 8+ characters, not a well-known password, not built from the user's
//     email or name, and not present in a public breach (Have I Been Pwned, k-anonymity: only
//     the first 5 hex characters of the SHA-1 leave the server). The breach lookup fails open
//     (a network problem never blocks a signup); PASSWORD_BREACH_CHECK=false turns it off.
// ---------------------------------------------------------------------------
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const BCRYPT_ROUNDS = 12;
const MIN_LENGTH = 8;
const MAX_BYTES = 72;

// Compared against when the email does not exist, so a login takes as long whether or not
// the account exists (otherwise response time reveals which emails are registered).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

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
  if (Buffer.byteLength(password, 'utf8') > MAX_BYTES) return `Password is too long (max ${MAX_BYTES} bytes).`;
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

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

// { ok, needsRehash }. `hash` may be null (unknown user): the dummy hash keeps the timing equal.
async function verifyPassword(password, hash) {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > MAX_BYTES * 4) {
    await bcrypt.compare('x', DUMMY_HASH);
    return { ok: false, needsRehash: false };
  }
  const ok = await bcrypt.compare(password, hash || DUMMY_HASH);
  return { ok: ok && Boolean(hash), needsRehash: ok && Boolean(hash) && bcrypt.getRounds(hash) < BCRYPT_ROUNDS };
}

// Login codes are stored hashed, so a database leak does not expose live codes.
const hashLoginCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');
function loginCodeMatches(provided, storedHash) {
  if (typeof provided !== 'string' || typeof storedHash !== 'string') return false;
  const a = Buffer.from(hashLoginCode(provided));
  const b = Buffer.from(storedHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  BCRYPT_ROUNDS, passwordProblem, validateNewPassword, breachCount, hashPassword, verifyPassword,
  hashLoginCode, loginCodeMatches,
};
