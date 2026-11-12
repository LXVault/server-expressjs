// Aggregate API router. Mounts all feature routers under /api.
import express, { type Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { apiLimiter, mcpLimiter } from '../middleware/rateLimit.js';

import authRoutes from './auth.js';
import documentRoutes from './documents.js';
import tokenRoutes from './tokens.js';
import meRoutes from './me.js';
import mcpRoutes from './mcp.js';
import { getProfile } from '../controllers/profileController.js';
import { getAnalysis } from '../controllers/analysisController.js';

const router: Router = express.Router();

router.get('/ping', (_req, res) => {
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

export default router;
