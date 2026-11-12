import fs from 'node:fs';
import path from 'node:path';
import { pool } from './db.js';

// Path to the canonical schema. This file compiles to dist/config/migrate.js,
// which sits at the same depth below the repository root as src/config/ did,
// so two levels up is the root either way. Under Docker the repo is copied to
// /app, so this resolves to /app/db/init.sql.
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'db', 'init.sql');

/**
 * Apply the idempotent schema in db/init.sql.
 *
 * Safe to run on every boot: every statement uses `IF NOT EXISTS` / guarded
 * `DO` blocks, so it creates whatever is missing and leaves existing objects
 * untouched. This keeps managed databases (e.g. Render Postgres, which has no
 * init-container hook) in sync without a separate manual migration step.
 *
 * Set AUTO_MIGRATE=false to disable (e.g. if you manage the schema yourself).
 */
export async function runMigrations(): Promise<void> {
  if (process.env.AUTO_MIGRATE === 'false') {
    console.log('[migrate] skipped (AUTO_MIGRATE=false)');
    return;
  }

  let sql: string;
  try {
    sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  } catch (err) {
    console.warn(`[migrate] could not read schema at ${SCHEMA_PATH}: ${(err as Error).message}`);
    return;
  }

  // node-postgres uses the simple query protocol when no parameters are passed,
  // which executes the whole multi-statement script (including the dollar-quoted
  // DO blocks) in one round trip.
  await pool.query(sql);
  console.log('[migrate] schema applied (db/init.sql)');
}
