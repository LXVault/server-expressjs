'use strict';

const express = require('express');
const cors = require('cors');
const config = require('./config/env');
const { healthCheck } = require('./config/db');

const app = express();

// --- Essential middleware ---
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());
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
