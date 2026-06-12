'use strict';

const db = require('../config/db');
const { encrypt } = require('../utils/crypto');

/**
 * GET /api/me/openrouter-key (protected)
 * Reports whether the caller has an OpenRouter key configured. Never returns
 * the key itself — only a masked hint (last 4 chars) and metadata.
 */
async function getKeyStatus(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT key_last4, created_at, updated_at
       FROM user_openrouter_keys
       WHERE user_id = $1`,
      [req.user.id]
    );
    const row = rows[0];
    return res.json({
      configured: Boolean(row),
      last4: row ? row.key_last4 : null,
      updatedAt: row ? row.updated_at : null,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * PUT /api/me/openrouter-key (protected)
 * Body: { apiKey }
 * Encrypts (AES-256-GCM) and stores the caller's OpenRouter API key, replacing
 * any previous one. The plaintext is never persisted or returned.
 */
async function setKey(req, res, next) {
  try {
    const { apiKey } = req.body || {};
    if (!apiKey || !String(apiKey).trim()) {
      return res.status(400).json({ error: 'apiKey is required' });
    }
    const raw = String(apiKey).trim();
    if (raw.length < 8) {
      return res.status(400).json({ error: 'apiKey looks too short to be valid' });
    }

    const { ciphertext, iv, authTag } = encrypt(raw);
    const last4 = raw.slice(-4);

    const { rows } = await db.query(
      `INSERT INTO user_openrouter_keys
         (user_id, key_ciphertext, key_iv, key_auth_tag, key_last4, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id)
       DO UPDATE SET key_ciphertext = EXCLUDED.key_ciphertext,
                     key_iv         = EXCLUDED.key_iv,
                     key_auth_tag   = EXCLUDED.key_auth_tag,
                     key_last4      = EXCLUDED.key_last4,
                     updated_at     = CURRENT_TIMESTAMP
       RETURNING key_last4, updated_at`,
      [req.user.id, ciphertext, iv, authTag, last4]
    );

    return res.status(201).json({
      configured: true,
      last4: rows[0].key_last4,
      updatedAt: rows[0].updated_at,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * DELETE /api/me/openrouter-key (protected)
 */
async function deleteKey(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM user_openrouter_keys WHERE user_id = $1`,
      [req.user.id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'No OpenRouter key configured' });
    }
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

module.exports = { getKeyStatus, setKey, deleteKey };
