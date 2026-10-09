// Unit tests for the password policy and the breach lookup (fetch is stubbed: no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const passwords = require('../passwords');

const KEY_A = crypto.randomBytes(32).toString('base64');
const KEY_B = crypto.randomBytes(32).toString('base64');
passwords.configure({ PASSWORD_PEPPER: KEY_A });

test('password policy', () => {
  assert.equal(passwords.passwordProblem('Blue-Kettle-Morning-7'), null);
  assert.equal(passwords.passwordProblem('ăîșțâăîșțâ'), null); // diacritics are fine (2 bytes each)
  assert.match(passwords.passwordProblem('short1'), /at least 8/);
  assert.equal(passwords.passwordProblem('Long passphrase '.repeat(10)), null); // no 72-byte cap any more
  assert.match(passwords.passwordProblem('x'.repeat(257)), /too long/);
  assert.match(passwords.passwordProblem('Password123'), /too common/);
  assert.match(passwords.passwordProblem('qwerty123!'), /too common/);
  assert.match(passwords.passwordProblem('11111111111'), /too easy/);
  assert.match(passwords.passwordProblem('alex2024!', { email: 'alex@x.io' }), /email/);
  assert.match(passwords.passwordProblem('Maria123', { name: 'Maria Pop' }), /name/);
  assert.equal(passwords.passwordProblem('StudentPass1!', { email: 'student@x.io', name: 'Student' }), null);
});

test('breach lookup (k-anonymity range API)', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; process.env.PASSWORD_BREACH_CHECK = undefined; });
  delete process.env.PASSWORD_BREACH_CHECK;
  const sha1 = crypto.createHash('sha1').update('hunter2-but-longer').digest('hex').toUpperCase();
  let requested = '';
  global.fetch = async (url) => {
    requested = url;
    return { ok: true, text: async () => `0000000000000000000000000000000000A:3\r\n${sha1.slice(5)}:42\r\n` };
  };
  assert.equal(await passwords.breachCount('hunter2-but-longer'), 42);
  assert.ok(requested.endsWith(`/range/${sha1.slice(0, 5)}`)); // only the 5-char prefix is sent
  assert.match(await passwords.validateNewPassword('hunter2-but-longer'), /data breach/);
  global.fetch = async () => ({ ok: true, text: async () => 'ABC:1\n' });
  assert.equal(await passwords.breachCount('Blue-Kettle-Morning-7'), 0);
  global.fetch = async () => { throw new Error('offline'); };
  assert.equal(await passwords.breachCount('Blue-Kettle-Morning-7'), null); // fails open
  assert.equal(await passwords.validateNewPassword('Blue-Kettle-Morning-7'), null);
  process.env.PASSWORD_BREACH_CHECK = 'false';
  global.fetch = async () => { throw new Error('must not be called'); };
  assert.equal(await passwords.breachCount('anything-at-all'), null);
});

test('stored hashes are sealed scrypt: a database copy alone holds nothing to crack', async (t) => {
  t.after(() => passwords.configure({ PASSWORD_PEPPER: KEY_A }));
  const stored = await passwords.hashPassword('Blue-Kettle-Morning-7');
  assert.match(stored, /^\$sealed\$v1\$[0-9a-f]{8}\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  // Neither the algorithm, its parameters, the salt nor the hash appear in the stored value
  assert.equal(/scrypt|\$2b\$|65536/.test(stored), false);
  const inner = passwords._internals.unseal(stored);
  assert.match(inner, /^scrypt\$65536\$8\$2\$/);
  assert.deepEqual(await passwords.verifyPassword('Blue-Kettle-Morning-7', stored), { ok: true, needsRehash: false });
  assert.deepEqual(await passwords.verifyPassword('wrong', stored), { ok: false, needsRehash: false });
  assert.deepEqual(await passwords.verifyPassword('Blue-Kettle-Morning-7', null), { ok: false, needsRehash: false });
  // Tampering with the ciphertext is detected (GCM tag)
  const flip = stored.at(-3) === 'A' ? 'B' : 'A'; // always a different character
  const tampered = stored.slice(0, -3) + flip + stored.slice(-2);
  assert.notEqual(tampered, stored);
  assert.equal((await passwords.verifyPassword('Blue-Kettle-Morning-7', tampered)).ok, false);

  // Without the key (an attacker holding only the database) the value cannot even be opened
  passwords.configure({ PASSWORD_PEPPER: KEY_B });
  assert.equal(passwords._internals.unseal(stored), null);
  // …and the server knows it is a key problem, not a wrong password (no lockout counting)
  assert.deepEqual(await passwords.verifyPassword('Blue-Kettle-Morning-7', stored), { ok: false, needsRehash: false, unreadable: true });

  // Key rotation: the old key in PASSWORD_PEPPER_PREVIOUS still opens it, and asks for a re-seal
  passwords.configure({ PASSWORD_PEPPER: KEY_B, PASSWORD_PEPPER_PREVIOUS: KEY_A });
  assert.deepEqual(await passwords.verifyPassword('Blue-Kettle-Morning-7', stored), { ok: true, needsRehash: true });
});

test('legacy bcrypt hashes verify, are sealed in place, and upgrade to scrypt on login', async () => {
  const bcrypt = require('bcrypt');
  const legacy = bcrypt.hashSync('Old-Password-From-2025', 10);
  assert.deepEqual(await passwords.verifyPassword('Old-Password-From-2025', legacy), { ok: true, needsRehash: true });
  // sealAllPasswords (startup) encrypts it without knowing the password
  const rows = [{ id: 1, password: legacy }, { id: 2, password: await passwords.hashPassword('Already-Sealed-1') }];
  const fakeDb = {
    query: async (sql, params) => {
      if (sql.startsWith('SELECT')) return [rows.filter((r) => !r.password.startsWith(params[0].replace('%', '')))];
      const row = rows.find((r) => r.id === params[1] && r.password === params[2]);
      if (row) row.password = params[0];
      return [[]];
    },
  };
  assert.deepEqual(await passwords.sealAllPasswords(fakeDb), { sealed: 1, failed: 0 });
  assert.match(rows[0].password, /^\$sealed\$v1\$/);
  assert.equal(rows[0].password.includes('$2b$'), false);
  // Still the same password; still flagged for the scrypt upgrade on the next login
  assert.deepEqual(await passwords.verifyPassword('Old-Password-From-2025', rows[0].password), { ok: true, needsRehash: true });
  assert.deepEqual(await passwords.sealAllPasswords(fakeDb), { sealed: 0, failed: 0 }); // idempotent
});

test('production refuses to run without PASSWORD_PEPPER; weak keys are rejected', (t) => {
  t.after(() => passwords.configure({ PASSWORD_PEPPER: KEY_A }));
  assert.throws(() => passwords.configure({}, { production: true }), /PASSWORD_PEPPER must be set/);
  // Fail closed: only an explicit development/test NODE_ENV may use the public dev key
  assert.throws(() => passwords.configure({}), /PASSWORD_PEPPER must be set/);                       // NODE_ENV unset
  assert.throws(() => passwords.configure({ NODE_ENV: 'staging' }), /PASSWORD_PEPPER must be set/);
  assert.match(passwords.configure({ NODE_ENV: 'development' }), /^[0-9a-f]{8}$/);
  assert.match(passwords.configure({ NODE_ENV: 'test' }), /^[0-9a-f]{8}$/);
  assert.throws(() => passwords.configure({ PASSWORD_PEPPER: 'short' }, { production: true }), /at least 32/);
  assert.match(passwords.configure({ PASSWORD_PEPPER: crypto.randomBytes(32).toString('hex') }, { production: true }), /^[0-9a-f]{8}$/);
});

test('at most two scrypt runs at once; the rest wait their turn', async () => {
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 6 }, () => passwords.hashPassword('Blue-Kettle-Morning-7')));
  assert.equal(results.length, 6);
  assert.equal(new Set(results).size, 6); // distinct salts/IVs, all completed
  assert.ok(Date.now() - started < 30000);
  assert.ok(passwords._internals.scryptStats.peak <= 2, `peak ${passwords._internals.scryptStats.peak}`);
  assert.equal(passwords._internals.scryptStats.peak, 2); // the six really did overlap, two at a time
});

test('login codes are stored as an HMAC under the pepper', () => {
  const stored = passwords.hashLoginCode('123456');
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.notEqual(stored, crypto.createHash('sha256').update('123456').digest('hex'));
  assert.equal(passwords.loginCodeMatches('123456', stored), true);
  assert.equal(passwords.loginCodeMatches('123457', stored), false);
  assert.equal(passwords.loginCodeMatches('123456', null), false);
});
