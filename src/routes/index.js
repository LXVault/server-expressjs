'use strict';

// Aggregate API router. Mounts all feature routers under /api.
const express = require('express');
const { requireAuth } = require('../middleware/auth');

const authRoutes = require('./auth');
const documentRoutes = require('./documents');
const tokenRoutes = require('./tokens');
const meRoutes = require('./me');
const mcpRoutes = require('./mcp');
const { getProfile } = require('../controllers/profileController');
const { getAnalysis } = require('../controllers/analysisController');

const router = express.Router();

router.get('/ping', (req, res) => {
  res.json({ pong: true });
});

// Public auth endpoints.
router.use('/auth', authRoutes);

// Protected endpoints.
router.get('/profile', requireAuth, getProfile);
router.use('/documents', documentRoutes);
router.use('/tokens', tokenRoutes);
router.use('/me', meRoutes);
router.get('/analysis', requireAuth, getAnalysis);

// MCP server endpoints (authenticated by per-project API token).
router.use('/mcp', mcpRoutes);

module.exports = router;
