'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../config/db');
const config = require('../config/env');
const { signToken } = require('../utils/jwt');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A hash of a value nobody holds, used to spend the same time on a sign-in for
// an account that does not exist as on one that does. See comparePassword.
const DECOY_PASSWORD = crypto.randomBytes(32).toString('hex');

let decoyHash = null;

/**
 * The cost of answering a sign-in attempt, held constant across every outcome.
 *
 * bcrypt dominates the time of this endpoint, and it is deliberately expensive
 * — that is what makes the stored hash worth having. The problem is that a
 * "no such user" answer returned before any bcrypt call, while a "wrong
 * password" answer returned after one. The two responses were byte-identical to
 * a client and differed by roughly a hundredfold in latency, which turns the
 * generic message into a reliable oracle for "does this account exist".
 *
 * So both paths now do exactly one bcrypt comparison against the same cost
 * factor. What the caller cannot distinguish by timing, they cannot
 * distinguish at all.
 *
 * @param {string} password The submitted password.
 * @param {string|null} storedHash The real hash, or null for an absent account.
 * @returns {Promise<boolean>} True only when there is a real hash and it matches.
 */
async function comparePassword(password, storedHash) {
  if (decoyHash === null) {
    // Built once per process, on first use, rather than on every miss — a
    // decoy that cost as much as a real comparison is the entire point, and
    // building it per request would double the cost of every miss.
    decoyHash = await bcrypt.hash(DECOY_PASSWORD, config.bcryptSaltRounds);
  }
  return bcrypt.compare(password, storedHash || decoyHash);
}

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
       RETURNING id, username, email, token_version, created_at, updated_at`,
      [username, email, passwordHash]
    );

    const user = rows[0];
    const token = signToken(user);
    return res.status(201).json({ user, token });
  } catch (err) {
    if (err.code === '23505') {
      // The unique index fires here, and a distinct status for it is an
      // enumeration oracle: it answers "does this username or email already
      // exist" to an unauthenticated caller, one probe at a time. The message
      // deliberately does not say which of the two collided either.
      //
      // Registration is a create operation, not a lookup, and a client that
      // needs to know why should be told by the person who owns the address.
      // The cost is that a legitimate user re-registering gets a message that
      // does not name the field; it is the same trade every other auth
      // endpoint makes here, and the rate limiter is what keeps the probe from
      // being cheap.
      return res.status(409).json({
        error:
          'That username or email cannot be used for a new account. If you ' +
          'already have one, sign in instead.',
      });
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
      `SELECT id, username, email, password_hash, token_version, created_at, updated_at
       FROM users WHERE email = $1`,
      [email]
    );

    const user = rows[0];
    // One bcrypt comparison either way — see comparePassword. The `!user` case
    // does not short-circuit, so this call costs what it costs for a real
    // account and the timing says nothing about which it was.
    const match = await comparePassword(password, user ? user.password_hash : null);
    if (!user || !match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(user);
    delete user.password_hash;
    return res.json({ user, token });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/auth/logout
 *
 * Bumps the caller's `token_version`, which retires every session token signed
 * with the previous value. A stateless JWT has no other way to be cancelled —
 * before this, the only way to stop a leaked token working was to rotate the
 * global signing secret, which signs out every user at once.
 *
 * The bump is unconditional, so a client that retries this does not corrupt
 * anything. A second call with the *same* token is refused at requireAuth
 * before reaching here, because that token is already retired — which is the
 * right answer, not a bug: the session is over either way.
 */
async function logout(req, res, next) {
  try {
    await db.query(
      `UPDATE users SET token_version = token_version + 1 WHERE id = $1`,
      [req.user.id]
    );
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

module.exports = { register, login, logout, comparePassword };
