'use strict';

const db = require('../config/db');

/**
 * GET /api/profile (protected)
 * Returns the authenticated user's details.
 */
async function getProfile(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, username, email, created_at, updated_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ user: rows[0] });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getProfile };
