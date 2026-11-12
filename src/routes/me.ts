import express, { type Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getKeyStatus, setKey, deleteKey } from '../controllers/keyController.js';

const router: Router = express.Router();

// Everything under /api/me is for the authenticated user themselves.
router.use(requireAuth);

// Per-user OpenRouter API key (encrypted at rest, never returned in plaintext).
router.get('/openrouter-key', getKeyStatus);
router.put('/openrouter-key', setKey);
router.delete('/openrouter-key', deleteKey);

export default router;
