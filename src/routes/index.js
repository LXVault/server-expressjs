'use strict';

// Aggregate API router. Mounts all feature routers under /api.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { apiLimiter, mcpLimiter } = require('../middleware/rateLimit');

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

// Public auth endpoints. These carry their own, tighter limiters inside
// authRoutes, so they are mounted ahead of the general one below — a `use` that
// matches ends the walk down this router, and the tighter limit is the one that
// should be the one counting them.
router.use('/auth', authRoutes);

// MCP server endpoints (authenticated by per-project API token). Also mounted
// ahead of the general limiter, which has a smaller budget than this surface
// needs: an assistant working through a task makes a burst of calls by design.
// Its own limiter still caps a leaked token.
router.use('/mcp', mcpLimiter, mcpRoutes);

// Everything else shares one budget.
router.use(apiLimiter);

// Protected endpoints.
router.get('/profile', requireAuth, getProfile);
router.use('/documents', documentRoutes);
router.use('/tokens', tokenRoutes);
router.use('/me', meRoutes);
router.get('/analysis', requireAuth, getAnalysis);

module.exports = router;
