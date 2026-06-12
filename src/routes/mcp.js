'use strict';

// MCP-facing API. Authenticated by per-project API token (not JWT) so the
// non-interactive MCP server can act on a user's behalf and have every call
// traced back to them via audit_logs.
const express = require('express');
const { requireApiToken } = require('../middleware/apiToken');
const { me, getProject, search } = require('../controllers/mcpController');

const router = express.Router();

router.use(requireApiToken);

router.get('/me', me);
router.get('/project', getProject);
router.post('/search', search);

module.exports = router;
