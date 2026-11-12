import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import config from './env.js';

// A single shared pool for the whole process. The connection string falls
// back to a local default when DATABASE_URL is not provided.
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: parseInt(process.env.PG_POOL_MAX ?? '', 10) || 10,
  idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT ?? '', 10) || 30000,
});

pool.on('error', (err: Error) => {
  // Don't crash the process on idle-client errors; just log them.
  console.error('[db] Unexpected error on idle PostgreSQL client:', err.message);
});

/**
 * Run a parameterised query against the pool.
 * @param text SQL text with $1, $2 ... placeholders.
 * @param params Bound parameters.
 */
export function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<R>> {
  return pool.query<R>(text, params);
}

/**
 * Lightweight connectivity check used by the health endpoint and on boot.
 */
export async function healthCheck(): Promise<boolean> {
  const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
  return Boolean(rows[0] && rows[0].ok === 1);
}

export { pool };

/** Anything that can run a query: the pool, or a client checked out of it. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<R>>;
}
