import express, { type Router } from 'express';
import { register, login, logout } from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiter, registerLimiter } from '../middleware/rateLimit.js';

const router: Router = express.Router();

// Each credential endpoint gets its own budget. Sign-in is keyed on the
// account as well as the address so one address cannot grind through a list of
// accounts; registration is keyed on the address alone, because the account is
// what is being created and keying on it would give every attempt its own
// budget. See src/middleware/rateLimit.js.
router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);

// Authenticated, unlike the two above: logging out is only meaningful for a
// session that exists. The handler is idempotent, so a client that calls this
// on a token it has already discarded still gets a clean answer.
router.post('/logout', requireAuth, logout);

export default router;
