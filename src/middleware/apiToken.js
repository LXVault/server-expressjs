'use strict';

const db = require('../config/db');
const { hashToken } = require('../utils/apiToken');

/**
 * Authenticate a request using a per-project API token (used by the MCP server).
 *
 * The token may be supplied either as `Authorization: Bearer <token>` or via the
 * `X-API-Token` header. On success it attaches:
 *   req.apiToken = { tokenId, userId, projectId, username, projectTitle, role }
 * and refreshes the token's `last_used_at` timestamp.
 *
 * A token is re-checked against live membership on every request. A token is a
 * grant, not a credential that outlives the reason it was issued: if the member
 * who created it has since been removed from the project, the join below stops
 * resolving and the token stops working immediately, with no explicit revoke.
 * The project owner is admitted directly from `documents.owner_id` and needs no
 * membership row.
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
              d.title         AS project_title,
              (d.owner_id = t.user_id) AS is_owner,
              dm.role         AS member_role
       FROM api_tokens t
       JOIN users u     ON u.id = t.user_id
       JOIN documents d ON d.id = t.project_id
       LEFT JOIN document_members dm
              ON dm.document_id = t.project_id
             AND dm.user_id = t.user_id
       WHERE t.token_hash = $1
         AND t.is_active = TRUE
         AND (t.expires_at IS NULL OR t.expires_at > CURRENT_TIMESTAMP)
         -- The token's user must still own or belong to the project it names.
         AND (d.owner_id = t.user_id OR dm.user_id IS NOT NULL)`,
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
      // 'owner' for the owner, otherwise the live member role. A token issued
      // while someone was an editor and demoted to viewer stops writing on the
      // next request, because this is read fresh rather than from the token.
      role: row.is_owner ? 'owner' : row.member_role,
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
