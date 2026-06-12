'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getKeyStatus, setKey, deleteKey } = require('../controllers/keyController');

const router = express.Router();

// Everything under /api/me is for the authenticated user themselves.
router.use(requireAuth);

// Per-user OpenRouter API key (encrypted at rest, never returned in plaintext).
router.get('/openrouter-key', getKeyStatus);
router.put('/openrouter-key', setKey);
router.delete('/openrouter-key', deleteKey);

module.exports = router;
