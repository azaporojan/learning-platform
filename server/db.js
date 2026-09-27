// PostgreSQL connection pool + a small compatibility layer.
//
// The route code was originally written against mysql2 (`const [rows] = await db.query(sql, params)`
// with `?` placeholders and `result.insertId`). This module keeps that calling convention on top of
// `pg` so the routes stay readable:
//   - `?` placeholders are rewritten to `$1..$n`
//   - `VALUES ?` with an array-of-arrays parameter expands to a multi-row VALUES list
//   - INSERT statements get `RETURNING id` appended (unless they already return something) and the
//     returned array carries `insertId`
//   - every result array carries `affectedRows` (= rowCount)
const { Pool, types } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

// Return BIGINT/COUNT(*) as JS numbers instead of strings (mysql2 did the same).
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'learning',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'learning',
  max: parseInt(process.env.DB_POOL_SIZE || '10', 10),
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client:', err.message || err);
});

/**
 * Rewrite mysql-style `?` placeholders into `$n` and expand bulk `VALUES ?`.
 * Question marks inside single-quoted string literals are left untouched.
 */
function toPgQuery(sql, params = []) {
  let out = '';
  let inString = false;
  let paramIdx = 0;
  const values = [];

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inString = !inString;
      out += ch;
      continue;
    }
    if (ch !== '?' || inString) {
      out += ch;
      continue;
    }
    if (paramIdx >= params.length) {
      throw new Error(`[DB] Missing parameter for placeholder #${paramIdx + 1} in: ${sql}`);
    }
    const p = params[paramIdx++];
    if (Array.isArray(p) && Array.isArray(p[0])) {
      // Bulk insert: VALUES ? with [[a, b], [c, d]]
      const tuples = p.map((row) => {
        const slots = row.map((v) => {
          values.push(v);
          return `$${values.length}`;
        });
        return `(${slots.join(', ')})`;
      });
      out += tuples.join(', ');
    } else {
      values.push(p);
      out += `$${values.length}`;
    }
  }

  if (paramIdx < params.length) {
    throw new Error(`[DB] Too many parameters (${params.length}) for: ${sql}`);
  }

  return { text: out, values };
}

function isInsert(text) {
  return /^\s*insert\b/i.test(text) && !/\breturning\b/i.test(text);
}

async function query(sql, params = []) {
  const { text, values } = toPgQuery(sql, params);
  const finalText = isInsert(text) ? `${text} RETURNING id` : text;
  const result = await pool.query(finalText, values);
  const rows = result.rows || [];
  rows.affectedRows = result.rowCount;
  if (isInsert(text)) {
    rows.insertId = rows.length > 0 ? rows[0].id : null;
  }
  return [rows, result];
}

module.exports = { query, pool, toPgQuery };
