'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  listDocuments,
  createDocument,
  getDocument,
  listMembers,
  addMember,
  removeMember,
} = require('../controllers/documentController');
const {
  getProjectToken,
  generateProjectToken,
  revokeProjectToken,
} = require('../controllers/tokenController');
const {
  getEmbeddingModel,
  setEmbeddingModel,
} = require('../controllers/projectModelController');

const router = express.Router();

// All document routes require authentication.
router.use(requireAuth);

router.get('/', listDocuments);
router.post('/', createDocument);
router.get('/:id', getDocument);

router.get('/:id/members', listMembers);
router.post('/:id/members', addMember);
router.delete('/:id/members/:userId', removeMember);

// Per-project execution token (one per user per project).
router.get('/:id/token', getProjectToken);
router.post('/:id/token', generateProjectToken);
router.delete('/:id/token', revokeProjectToken);

// Per-project embedding model (read for members; change for owner/admin).
router.get('/:id/embedding-model', getEmbeddingModel);
router.put('/:id/embedding-model', setEmbeddingModel);

module.exports = router;
