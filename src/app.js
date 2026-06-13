'use strict';

const express = require('express');
const cors = require('cors');
const config = require('./config/env');
const { healthCheck } = require('./config/db');

const app = express();

// Build a forgiving CORS policy from CORS_ORIGIN.
//   - unset or '*'  -> reflect any origin (the app uses bearer tokens, not
//     cookies, so this is safe and avoids deploy-time friction)
//   - otherwise     -> a comma-separated allow-list, compared with trailing
//     slashes stripped so "https://app.com/" and "https://app.com" both match
function buildCorsOptions(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed === '*') {
    return { origin: true };
  }
  const allow = trimmed
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return {
    origin(origin, cb) {
      // Non-browser clients (curl, the MCP server) send no Origin — allow them.
      if (!origin) return cb(null, true);
      return cb(null, allow.includes(origin.replace(/\/+$/, '')));
    },
  };
}

// --- Essential middleware ---
app.use(cors(buildCorsOptions(config.corsOrigin)));
// Raised from the 100kb default so base64-encoded file uploads via the MCP
// endpoint (/api/mcp/files) fit. Multipart web uploads bypass this (multer).
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Health check ---
app.get('/health', async (req, res) => {
  try {
    const dbOk = await healthCheck();
    res.json({ status: 'ok', db: dbOk ? 'up' : 'down' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'down', error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ name: 'mcp-rag-server', version: '1.0.0', status: 'running' });
});

// --- Routes are mounted here (auth & API added in later steps) ---
// eslint-disable-next-line global-require
app.use('/api', require('./routes'));

// --- 404 handler ---
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// --- Centralised error handler ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});

module.exports = app;
