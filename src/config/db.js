'use strict';

const { Pool } = require('pg');
const config = require('./env');

// A single shared pool for the whole process. The connection string falls
// back to a local default when DATABASE_URL is not provided.
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: parseInt(process.env.PG_POOL_MAX, 10) || 10,
  idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT, 10) || 30000,
});

pool.on('error', (err) => {
  // Don't crash the process on idle-client errors; just log them.
  console.error('[db] Unexpected error on idle PostgreSQL client:', err.message);
});

/**
 * Run a parameterised query against the pool.
 * @param {string} text SQL text with $1, $2 ... placeholders.
 * @param {Array} [params] Bound parameters.
 */
function query(text, params) {
  return pool.query(text, params);
}

/**
 * Lightweight connectivity check used by the health endpoint and on boot.
 */
async function healthCheck() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0] && rows[0].ok === 1;
}

module.exports = { pool, query, healthCheck };
