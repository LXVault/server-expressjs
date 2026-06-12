'use strict';

const db = require('../config/db');
const { hashToken } = require('../utils/apiToken');

/**
 * Authenticate a request using a per-project API token (used by the MCP server).
 *
 * The token may be supplied either as `Authorization: Bearer <token>` or via the
 * `X-API-Token` header. On success it attaches:
 *   req.apiToken = { tokenId, userId, projectId, username, projectTitle }
 * and refreshes the token's `last_used_at` timestamp.
 *
 * This is intentionally separate from `requireAuth` (JWT): MCP clients are
 * non-interactive and identify themselves by token, not by login session.
 */
async function requireApiToken(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, bearer] = header.split(' ');
  const raw =
    (scheme === 'Bearer' && bearer) ||
    req.headers['x-api-token'] ||
    '';

  if (!raw) {
    return res.status(401).json({ error: 'Missing API token' });
  }

  try {
    const tokenHash = hashToken(String(raw).trim());
    const { rows } = await db.query(
      `SELECT t.id            AS token_id,
              t.user_id       AS user_id,
              t.project_id    AS project_id,
              u.username      AS username,
              d.title         AS project_title
       FROM api_tokens t
       JOIN users u     ON u.id = t.user_id
       JOIN documents d ON d.id = t.project_id
       WHERE t.token_hash = $1
         AND t.is_active = TRUE
         AND (t.expires_at IS NULL OR t.expires_at > CURRENT_TIMESTAMP)`,
      [tokenHash]
    );

    const row = rows[0];
    if (!row) {
      return res.status(401).json({ error: 'Invalid or revoked API token' });
    }

    req.apiToken = {
      tokenId: row.token_id,
      userId: row.user_id,
      projectId: row.project_id,
      username: row.username,
      projectTitle: row.project_title,
    };

    // Best-effort "last seen" update; don't block the request on it.
    db.query(`UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1`, [
      row.token_id,
    ]).catch((err) => console.error('[apiToken] last_used_at update failed:', err.message));

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireApiToken };
