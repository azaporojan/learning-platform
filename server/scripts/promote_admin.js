// Promote an existing user to admin (and approve them).
// Usage: node scripts/promote_admin.js user@example.com
// Alternative without shell access: set BOOTSTRAP_ADMIN_EMAIL before that user registers.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const db = require('../db');

async function promoteToAdmin(email) {
  const [users] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
  if (users.length === 0) {
    console.error(`User with email ${email} not found.`);
    process.exit(1);
  }
  await db.query('UPDATE users SET role = ?, is_approved = ? WHERE email = ?', ['admin', true, email]);
  console.log(`User ${email} has been promoted to ADMIN and approved.`);
  await db.pool.end();
}

const targetEmail = (process.argv[2] || '').trim().toLowerCase();
if (!targetEmail) {
  console.error('Usage: node scripts/promote_admin.js user@example.com');
  process.exit(1);
}
promoteToAdmin(targetEmail).catch((err) => {
  console.error('Error promoting user:', err.message || err);
  process.exit(1);
});
