import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../lib/db.js';

/**
 * Minimal forward-only migrator: applies any .sql file in ./migrations that
 * has not been recorded yet, in filename order, each in its own transaction.
 */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const run = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
      r => r.name,
    ),
  );

  const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
      count += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`FAILED ${file}`);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(count ? `${count} migration(s) applied` : 'already up to date');
  await pool.end();
};

run().catch(err => {
  console.error(err);
  process.exit(1);
});
