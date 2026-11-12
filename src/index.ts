import app from './app.js';
import config from './config/env.js';
import { healthCheck } from './config/db.js';
import { runMigrations } from './config/migrate.js';

const server = app.listen(config.port, async () => {
  console.log(`[server] listening on port ${config.port} (${config.nodeEnv})`);
  try {
    await healthCheck();
    console.log('[db] connection OK');
  } catch (err) {
    // Non-fatal: the server still serves requests; DB-backed routes will error.
    console.warn('[db] connection check failed:', (err as Error).message);
  }
  try {
    // Apply the idempotent schema so a fresh/managed database is ready to use.
    await runMigrations();
  } catch (err) {
    console.error('[migrate] failed to apply schema:', (err as Error).message);
  }
});

// Graceful shutdown.
const shutdown = (signal: NodeJS.Signals): void => {
  console.log(`[server] received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
};
(['SIGINT', 'SIGTERM'] as const).forEach((sig) => process.on(sig, () => shutdown(sig)));

export default server;
