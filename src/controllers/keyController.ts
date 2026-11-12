import type { NextFunction, Request, Response } from 'express';
import * as db from '../config/db.js';
import { encrypt } from '../utils/crypto.js';

/**
 * GET /api/me/openrouter-key (protected)
 * Reports whether the caller has an OpenRouter key configured. Never returns
 * the key itself — only a masked hint (last 4 chars) and metadata.
 */
export async function getKeyStatus(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  try {
    const { rows } = await db.query<{ key_last4: string; created_at: Date; updated_at: Date }>(
      `SELECT key_last4, created_at, updated_at
       FROM user_openrouter_keys
       WHERE user_id = $1`,
      [req.user!.id]
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
export async function setKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  try {
    const { apiKey } = (req.body || {}) as { apiKey?: unknown };
    if (!apiKey || !String(apiKey).trim()) {
      return res.status(400).json({ error: 'apiKey is required' });
    }
    const raw = String(apiKey).trim();
    if (raw.length < 8) {
      return res.status(400).json({ error: 'apiKey looks too short to be valid' });
    }

    const { ciphertext, iv, authTag, salt, kdf } = await encrypt(raw);
    const last4 = raw.slice(-4);

    const { rows } = await db.query<{ key_last4: string; updated_at: Date }>(
      `INSERT INTO user_openrouter_keys
         (user_id, key_ciphertext, key_iv, key_auth_tag,
          key_salt, key_kdf, key_last4, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id)
       DO UPDATE SET key_ciphertext = EXCLUDED.key_ciphertext,
                     key_iv         = EXCLUDED.key_iv,
                     key_auth_tag   = EXCLUDED.key_auth_tag,
                     key_salt       = EXCLUDED.key_salt,
                     key_kdf        = EXCLUDED.key_kdf,
                     key_last4      = EXCLUDED.key_last4,
                     updated_at     = CURRENT_TIMESTAMP
       RETURNING key_last4, updated_at`,
      [req.user!.id, ciphertext, iv, authTag, salt, kdf, last4]
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
export async function deleteKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM user_openrouter_keys WHERE user_id = $1`,
      [req.user!.id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'No OpenRouter key configured' });
    }
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}
