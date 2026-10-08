// EMERGENCY ONLY — before rolling the app back to a release older than the password sealing
// (migrations 008/009). Older releases only understand plain bcrypt hashes, so after a rollback
// nobody could log in with a password (open sessions keep working). This script turns every
// sealed hash whose inner hash is still bcrypt back into that bcrypt hash.
//
// Users who logged in after the upgrade have a scrypt hash, which the old release cannot verify
// and which cannot be converted without their password: they are listed, and keep the sealed
// value (they can log in again as soon as a current release is redeployed). Prefer fixing
// forward — redeploying a newer image — over rolling back.
//
// Needs the same PASSWORD_PEPPER (and PASSWORD_PEPPER_PREVIOUS) as the server, plus DB_*.
//   node scripts/unseal-passwords.js            # dry run: report only
//   node scripts/unseal-passwords.js --apply    # write the bcrypt hashes back
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const db = require('../db');
const passwords = require('../passwords');

async function main() {
  const apply = process.argv.includes('--apply');
  passwords.configure(process.env, { production: true }); // never with the dev fallback key
  const { unseal, isSealed } = passwords._internals;
  const [rows] = await db.query('SELECT id, email, password FROM users ORDER BY id');
  const restorable = [];
  const scryptUsers = [];
  const unreadable = [];
  for (const row of rows) {
    if (!isSealed(row.password)) continue;
    const inner = unseal(row.password);
    if (!inner) unreadable.push(row);
    else if (/^\$2[aby]\$/.test(inner)) restorable.push({ ...row, inner });
    else scryptUsers.push(row);
  }
  console.log(`${restorable.length} account(s) can be restored to bcrypt for the old release.`);
  if (scryptUsers.length > 0) {
    console.log(`${scryptUsers.length} account(s) logged in after the upgrade (scrypt) and cannot log in on the old release until a current release is back:`);
    scryptUsers.forEach((u) => console.log(`  - #${u.id} ${u.email}`));
  }
  if (unreadable.length > 0) console.log(`${unreadable.length} account(s) are sealed with a key not provided here (check PASSWORD_PEPPER / _PREVIOUS).`);
  if (!apply) {
    console.log('Dry run: nothing changed. Re-run with --apply to write.');
  } else {
    for (const u of restorable) {
      await db.query('UPDATE users SET password = ? WHERE id = ? AND password = ?', [u.inner, u.id, u.password]);
    }
    console.log(`Restored ${restorable.length} bcrypt hash(es). Deploy the old release now; a current release re-seals them at startup.`);
  }
  await db.pool.end();
}

main().catch((err) => {
  console.error('[unseal-passwords]', err.message || err);
  process.exit(1);
});
