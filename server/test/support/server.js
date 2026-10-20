// Shared helpers for tests that boot the real server against PostgreSQL (DB_* env vars).
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'learning',
  password: process.env.DB_PASSWORD || 'learning',
  database: process.env.DB_NAME || 'learning_test',
};

async function dbReachable() {
  const c = new Client(dbConfig);
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

async function resetDb() {
  const c = new Client(dbConfig);
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
}

async function dbQuery(sql, params) {
  const c = new Client(dbConfig);
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

function startServer({ port, uploadsDir, adminEmail, env = {} }) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DB_HOST: dbConfig.host,
      DB_PORT: String(dbConfig.port),
      DB_USER: dbConfig.user,
      DB_PASSWORD: dbConfig.password,
      DB_NAME: dbConfig.database,
      JWT_SECRET: process.env.JWT_SECRET || 'test-only-jwt-secret-that-is-long-enough-0123456789',
      BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      UPLOADS_DIR: uploadsDir,
      EMAIL_USER: '',
      EMAIL_PASS: '',
      PASSWORD_PEPPER: 'dGVzdC1vbmx5LXBlcHBlci10aGF0LWlzLTMyLWJ5dGVzLWxvbmch',
      PASSWORD_BREACH_CHECK: 'false',
      LOG_LOGIN_CODES: 'true',
      AUTH_RATE_LIMIT: '1000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  child.getOutput = () => output;
  return child;
}

async function waitForHealth(child, base) {
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${child.getOutput()}`);
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not become healthy:\n${child.getOutput()}`);
}

// Minimal cookie-jar fetch. opts.json sends JSON; opts.form sends a FormData body.
function session(base) {
  let cookieHeader = '';
  const call = async (pathname, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookieHeader) headers.cookie = cookieHeader;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(opts.json);
    }
    if (opts.form) opts.body = opts.form;
    const res = await fetch(`${base}${pathname}`, { ...opts, headers });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookieHeader = setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    let body = null;
    if (type.includes('application/json')) { try { body = await res.json(); } catch { body = null; } }
    else body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body, res };
  };
  return call;
}

function loginHelpers(child, base) {
  async function readLoginCode(email) {
    const re = new RegExp(`login code for ${email.toLowerCase().replace(/[.]/g, '\\.')}: (\\d{6})`, 'g');
    for (let i = 0; i < 40; i++) {
      const all = [...child.getOutput().matchAll(re)];
      if (all.length > 0) return all[all.length - 1][1];
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no login code logged for ${email}`);
  }
  async function loginAs(email, password) {
    const s = session(base);
    const login = await s('/login', { method: 'POST', json: { email, password } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const code = await readLoginCode(email);
    const verify = await s('/verify-code', { method: 'POST', json: { userId: login.body.userId, code } });
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    return s;
  }
  return { loginAs };
}

module.exports = { dbConfig, dbReachable, resetDb, dbQuery, startServer, waitForHealth, session, loginHelpers };
