// Migration 003 against a database that already carries content and students (the state of a
// production install before this release). Runs in its own schema so it can execute alongside
// the API smoke test. Skipped when no PostgreSQL is reachable.
//
//   DB_HOST=localhost DB_NAME=learning_test DB_USER=learning DB_PASSWORD=learning npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { runMigrations } = require('../db/migrate');

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'learning',
  password: process.env.DB_PASSWORD || 'learning',
  database: process.env.DB_NAME || 'learning_test',
};
const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
const sql = (file) => fs.readFileSync(path.join(migrationsDir, file), 'utf8');

test('003_courses: existing phases become the course, students stay enrolled', { timeout: 60000 }, async (t) => {
  const schema = `mig003_${Date.now().toString(36)}`;
  const admin = new Pool(dbConfig);
  try {
    await admin.query('SELECT 1');
  } catch (e) {
    t.skip(`no PostgreSQL reachable at ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
    await admin.end();
    return;
  }
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...dbConfig, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  // Pre-release state: 001 + 002 applied (001 seeds "HTML + CSS" / "JavaScript")
  await pool.query(sql('001_init.sql'));
  await pool.query(sql('002_api_keys.sql'));
  await pool.query(`CREATE TABLE schema_migrations (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`INSERT INTO schema_migrations (version) VALUES ('001_init.sql'), ('002_api_keys.sql')`);

  // Real content: two phases (listed by stars_required in the old UI) with a task each
  const { rows: [p2] } = await pool.query(`INSERT INTO paths (name, description, stars_required) VALUES ('Phase 2 — Testing', 'd', 120) RETURNING id`);
  const { rows: [p1] } = await pool.query(`INSERT INTO paths (name, description, stars_required) VALUES ('Phase 1 — Java', 'd', 0) RETURNING id`);
  // A path that reuses a seed name but is real content (different description): must survive
  const { rows: [reused] } = await pool.query(`INSERT INTO paths (name, description, stars_required) VALUES ('JavaScript', 'Our own JS phase', 200) RETURNING id`);
  const { rows: [l1] } = await pool.query(`INSERT INTO lessons (path_id, title, order_index) VALUES ($1, 'Week 1', 1) RETURNING id`, [p1.id]);
  const { rows: [t1] } = await pool.query(`INSERT INTO tasks (lesson_id, title) VALUES ($1, 'Homework 1') RETURNING id`, [l1.id]);

  // Students: A unlocked phase 1, B has approved work in it, C never started, plus an admin
  const user = async (name, role) => (await pool.query(`INSERT INTO users (name, email, password, role, is_approved) VALUES ($1, $2, 'x', $3, TRUE) RETURNING id`, [name, `${name}@example.test`, role])).rows[0].id;
  const a = await user('a', 'student');
  const b = await user('b', 'student');
  const c = await user('c', 'student');
  const adm = await user('adm', 'admin');
  await pool.query(`INSERT INTO user_paths (user_id, path_id) VALUES ($1, $2)`, [a, p1.id]);
  await pool.query(`INSERT INTO user_progress (user_id, entity_type, entity_id) VALUES ($1, 'task', $2)`, [b, t1.id]);

  await runMigrations(pool);

  const { rows: applied } = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(applied.map((r) => r.version).slice(0, 3), ['001_init.sql', '002_api_keys.sql', '003_courses.sql']);

  const { rows: courses } = await pool.query('SELECT id, name FROM courses');
  assert.equal(courses.length, 1);
  assert.equal(courses[0].name, 'QA Automation Engineer');

  // Only the untouched 001 seed rows are gone; everything else is a phase of the course, in the old order
  const { rows: paths } = await pool.query('SELECT name, course_id, order_index, requires_previous FROM paths ORDER BY order_index');
  assert.deepEqual(paths.map((p) => [p.name, p.course_id === courses[0].id, p.order_index, p.requires_previous]), [
    ['Phase 1 — Java', true, 1, true],
    ['Phase 2 — Testing', true, 2, true],
    ['JavaScript', true, 3, true],
  ]);
  assert.equal(paths.find((p) => p.name === 'HTML + CSS'), undefined);

  // Students who had unlocked a phase or had progress in one are enrolled; others are not
  const { rows: enrolled } = await pool.query('SELECT user_id FROM course_enrollments ORDER BY user_id');
  assert.deepEqual(enrolled.map((r) => r.user_id), [a, b]);
  assert.ok(!enrolled.some((r) => r.user_id === c || r.user_id === adm));
});
