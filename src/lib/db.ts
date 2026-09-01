import pg from 'pg';
import { config } from '../config.js';

// Postgres returns BIGINT/COUNT as a string to avoid precision loss. Every
// count in this API is small, so parse them to numbers at the driver level.
pg.types.setTypeParser(pg.types.builtins.INT8, value => Number(value));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export type Sql = pg.Pool | pg.PoolClient;

export const query = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: Sql = pool,
): Promise<T[]> => {
  const result = await client.query<T>(text, params as never[]);
  return result.rows;
};

export const queryOne = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: Sql = pool,
): Promise<T | null> => {
  const rows = await query<T>(text, params, client);
  return rows[0] ?? null;
};

/** Runs `fn` inside a transaction, rolling back on any thrown error. */
export const transaction = async <T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};
