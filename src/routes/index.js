'use strict';

// Aggregate API router. Feature routers (auth, profile, documents, analysis)
// are mounted here in later steps.
const express = require('express');

const router = express.Router();

router.get('/ping', (req, res) => {
  res.json({ pong: true });
});

module.exports = router;
