'use strict';

// Aggregate API router. Mounts all feature routers under /api.
const express = require('express');
const { requireAuth } = require('../middleware/auth');

const authRoutes = require('./auth');
const { getProfile } = require('../controllers/profileController');
const { listDocuments } = require('../controllers/documentController');
const { getAnalysis } = require('../controllers/analysisController');

const router = express.Router();

router.get('/ping', (req, res) => {
  res.json({ pong: true });
});

// Public auth endpoints.
router.use('/auth', authRoutes);

// Protected endpoints.
router.get('/profile', requireAuth, getProfile);
router.get('/documents', requireAuth, listDocuments);
router.get('/analysis', requireAuth, getAnalysis);

module.exports = router;
