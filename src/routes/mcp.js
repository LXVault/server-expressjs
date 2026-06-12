'use strict';

// MCP-facing API. Authenticated by per-project API token (not JWT) so the
// non-interactive MCP server can act on a user's behalf and have every call
// traced back to them via audit_logs.
const express = require('express');
const { requireApiToken } = require('../middleware/apiToken');
const {
  me,
  getProject,
  search,
  addKnowledge,
  createProject,
  updateProjectTitle,
  updateProjectDescription,
  addProjectMember,
} = require('../controllers/mcpController');

const router = express.Router();

router.use(requireApiToken);

router.get('/me', me);
router.get('/project', getProject);
router.post('/search', search);
router.post('/knowledge', addKnowledge);

// Project management (owner/admin enforced server-side from the token).
router.post('/projects', createProject);
router.put('/project/title', updateProjectTitle);
router.put('/project/description', updateProjectDescription);
router.post('/project/members', addProjectMember);

module.exports = router;
