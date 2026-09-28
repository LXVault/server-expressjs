'use strict';

const express = require('express');
const { register, login } = require('../controllers/authController');
const { loginLimiter, registerLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Each credential endpoint gets its own budget. Sign-in is keyed on the
// account as well as the address so one address cannot grind through a list of
// accounts; registration is keyed on the address alone, because the account is
// what is being created and keying on it would give every attempt its own
// budget. See src/middleware/rateLimit.js.
router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);

module.exports = router;
