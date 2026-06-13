'use strict';

const app = require('./app');
const config = require('./config/env');
const { healthCheck } = require('./config/db');
const { runMigrations } = require('./config/migrate');

const server = app.listen(config.port, async () => {
  console.log(`[server] listening on port ${config.port} (${config.nodeEnv})`);
  try {
    await healthCheck();
    console.log('[db] connection OK');
  } catch (err) {
    // Non-fatal: the server still serves requests; DB-backed routes will error.
    console.warn('[db] connection check failed:', err.message);
  }
  try {
    // Apply the idempotent schema so a fresh/managed database is ready to use.
    await runMigrations();
  } catch (err) {
    console.error('[migrate] failed to apply schema:', err.message);
  }
});

// Graceful shutdown.
const shutdown = (signal) => {
  console.log(`[server] received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
};
['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => shutdown(sig)));

module.exports = server;
