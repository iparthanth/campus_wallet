import pg from 'pg';
import { config } from '../config.js';

// pg returns BIGINT (int8) as a STRING by default, to avoid silent precision loss.
// Our money is paisa: Number.MAX_SAFE_INTEGER paisa is ~৳90 trillion, far beyond any campus
// wallet, so parsing int8 to Number here is safe AND keeps arithmetic simple.
// ponytail: if this ever needs real-bank scale, switch to BigInt and remove this parser.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err);
});

export const query = (text, params) => pool.query(text, params);

/**
 * Run fn inside a transaction. Commits on success, rolls back on any throw.
 * Every money path goes through this — there is no "just one UPDATE" shortcut.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already dead */ }
    throw err;
  } finally {
    client.release();
  }
}

export const closePool = () => pool.end();
