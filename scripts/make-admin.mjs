/**
 * Grants admin access to an existing account.
 *
 *   node scripts/make-admin.mjs --email you@example.com --key <ADMIN_BOOTSTRAP_KEY>
 *
 * There is no self-serve admin signup and no API endpoint that grants
 * is_admin -- the only way to create the first admin is this script, run by
 * whoever holds both database access and ADMIN_BOOTSTRAP_KEY from .env.
 * That key is a second factor, purely so a leaked DATABASE_URL alone (e.g. in
 * a misconfigured log line) is not enough to mint an admin account.
 */
import 'dotenv/config';
import pg from 'pg';

const arg = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

const email = arg('email');
const key = arg('key');

if (!email) {
  console.error('Usage: node scripts/make-admin.mjs --email you@example.com --key <ADMIN_BOOTSTRAP_KEY>');
  process.exit(1);
}

if (!process.env.ADMIN_BOOTSTRAP_KEY) {
  console.error('ADMIN_BOOTSTRAP_KEY is not set in .env. Set it to a long random ' +
    'value before granting admin access -- this is what stops the script running ' +
    'without a second, out-of-band secret.');
  process.exit(1);
}

if (key !== process.env.ADMIN_BOOTSTRAP_KEY) {
  console.error('Wrong --key.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pool.query(
  `UPDATE users SET is_admin = TRUE WHERE email = $1
   RETURNING id, email, name, is_admin`,
  [email],
);

if (!rows.length) {
  console.error(`No user found with email ${email}. They must register a normal ` +
    'account first, then be promoted.');
  process.exit(1);
}

console.log(`Granted admin access to ${rows[0].email} (${rows[0].name}).`);
console.log('Sign in at /admin with that account\'s email and password.');
await pool.end();
