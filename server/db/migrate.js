// Forward-only SQL migrations, applied in filename order at server start.
// Each file in db/migrations/ runs once inside a transaction; applied versions are
// recorded in schema_migrations. Never edit an applied migration — add a new one.
const fs = require('fs');
const path = require('path');

async function runMigrations(pool) {
  const dir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const client = await pool.connect();
  // Migrations report things an operator must act on with RAISE WARNING (routine NOTICEs such
  // as "trigger ... does not exist, skipping" are not logged)
  const onNotice = (msg) => { if (msg.severity === 'WARNING') console.warn(`[DB] WARNING: ${msg.message}`); };
  client.on('notice', onNotice);
  try {
    // Serialize concurrent starts (e.g. two replicas) with an advisory lock.
    await client.query('SELECT pg_advisory_lock(727270)');
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log(`[DB] Applying migration ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`[DB] Migration ${file} failed: ${err.message}`);
      }
    }
    await client.query('SELECT pg_advisory_unlock(727270)');
  } finally {
    client.off('notice', onNotice);
    client.release();
  }
}

module.exports = { runMigrations };
