import express, { type Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { listTokens } from '../controllers/tokenController.js';

const router: Router = express.Router();

// All token routes require an authenticated user session.
router.use(requireAuth);

// List every project token the caller owns (metadata only).
router.get('/', listTokens);

export default router;
