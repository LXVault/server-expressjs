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

const router = express.Router();

// All document routes require authentication.
router.use(requireAuth);

router.get('/', listDocuments);
router.post('/', createDocument);
router.get('/:id', getDocument);

router.get('/:id/members', listMembers);
router.post('/:id/members', addMember);
router.delete('/:id/members/:userId', removeMember);

module.exports = router;
