// Unit tests for the password policy and the breach lookup (fetch is stubbed: no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const passwords = require('../passwords');

test('password policy', () => {
  assert.equal(passwords.passwordProblem('Blue-Kettle-Morning-7'), null);
  assert.equal(passwords.passwordProblem('ăîșțâăîșțâ'), null); // diacritics are fine (2 bytes each)
  assert.match(passwords.passwordProblem('short1'), /at least 8/);
  assert.match(passwords.passwordProblem('x'.repeat(73)), /too long/);
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

test('hashing and login codes', async () => {
  const hash = await passwords.hashPassword('Blue-Kettle-Morning-7');
  assert.match(hash, /^\$2b\$12\$/);
  assert.deepEqual(await passwords.verifyPassword('Blue-Kettle-Morning-7', hash), { ok: true, needsRehash: false });
  assert.deepEqual(await passwords.verifyPassword('wrong', hash), { ok: false, needsRehash: false });
  assert.deepEqual(await passwords.verifyPassword('Blue-Kettle-Morning-7', null), { ok: false, needsRehash: false });
  const stored = passwords.hashLoginCode('123456');
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.equal(passwords.loginCodeMatches('123456', stored), true);
  assert.equal(passwords.loginCodeMatches('123457', stored), false);
  assert.equal(passwords.loginCodeMatches('123456', null), false);
});
