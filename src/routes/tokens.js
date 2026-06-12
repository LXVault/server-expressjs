'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { listTokens } = require('../controllers/tokenController');

const router = express.Router();

// All token routes require an authenticated user session.
router.use(requireAuth);

// List every project token the caller owns (metadata only).
router.get('/', listTokens);

module.exports = router;
