'use strict';

const bcrypt = require('bcryptjs');
const db = require('../config/db');
const config = require('../config/env');
const { signToken } = require('../utils/jwt');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/auth/register
 * Body: { username, email, password }
 * Hashes the password with bcrypt before persisting.
 */
async function register(req, res, next) {
  try {
    const { username, email, password } = req.body || {};

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email and password are required' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const passwordHash = await bcrypt.hash(password, config.bcryptSaltRounds);

    const { rows } = await db.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, created_at, updated_at`,
      [username, email, passwordHash]
    );

    const user = rows[0];
    const token = signToken(user);
    return res.status(201).json({ user, token });
  } catch (err) {
    // Unique violation on username or email.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username or email already in use' });
    }
    return next(err);
  }
}

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Returns a JWT on success.
 */
async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const { rows } = await db.query(
      `SELECT id, username, email, password_hash, created_at, updated_at
       FROM users WHERE email = $1`,
      [email]
    );

    const user = rows[0];
    // Use a generic message to avoid leaking which part was wrong.
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(user);
    delete user.password_hash;
    return res.json({ user, token });
  } catch (err) {
    return next(err);
  }
}

module.exports = { register, login };
