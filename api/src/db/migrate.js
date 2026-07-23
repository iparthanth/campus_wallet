import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction, closePool } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

/**
 * Forward-only migration runner. Each file runs once, inside its own transaction,
 * and is recorded in schema_migrations. Re-running is a no-op — that is what makes
 * `npm run migrate` safe to run on every deploy.
 */
export async function migrate({ silent = false } = {}) {
  const log = (...a) => { if (!silent) console.log(...a); };

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const applied = new Set(
    (await pool.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename)
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    });
    log(`  applied ${file}`);
    count++;
  }

  log(count ? `migrate: ${count} migration(s) applied` : 'migrate: already up to date');
  return count;
}

// Only auto-run when invoked directly (`npm run migrate`), not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  migrate()
    .then(closePool)
    .catch((err) => { console.error('migrate failed:', err.message); process.exit(1); });
}
