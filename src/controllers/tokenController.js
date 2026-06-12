'use strict';

const db = require('../config/db');
const { generateRawToken, hashToken } = require('../utils/apiToken');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Resolve a project (document) and whether the caller may access it.
 * A user can manage a token for a project they own OR are a member of.
 * @returns {Promise<{project: Object, hasAccess: boolean}|null>} null when not found.
 */
async function loadProjectAccess(projectId, userId) {
  const { rows } = await db.query(
    `SELECT d.id,
            d.title,
            d.owner_id,
            (d.owner_id = $2) AS is_owner,
            EXISTS (
              SELECT 1 FROM document_members dm
              WHERE dm.document_id = d.id AND dm.user_id = $2
            ) AS is_member
     FROM documents d
     WHERE d.id = $1`,
    [projectId, userId]
  );
  if (!rows[0]) return null;
  const { is_owner: isOwner, is_member: isMember, ...project } = rows[0];
  return { project, hasAccess: isOwner || isMember };
}

/**
 * GET /api/tokens (protected)
 * Lists the metadata of every project token the caller owns. Never returns the
 * raw token value (that is only shown once, at generation time).
 */
async function listTokens(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT t.id,
              t.project_id,
              d.title AS project_title,
              t.token_name,
              t.is_active,
              t.last_used_at,
              t.created_at
       FROM api_tokens t
       JOIN documents d ON d.id = t.project_id
       WHERE t.user_id = $1
       ORDER BY t.created_at DESC`,
      [req.user.id]
    );
    return res.json({ tokens: rows, total: rows.length });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/documents/:id/token (protected)
 * Returns metadata about the caller's token for this project, if one exists.
 */
async function getProjectToken(req, res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid project id' });

    const access = await loadProjectAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Project not found' });
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'You do not have access to this project' });
    }

    const { rows } = await db.query(
      `SELECT id, project_id, token_name, is_active, last_used_at, created_at
       FROM api_tokens
       WHERE user_id = $1 AND project_id = $2`,
      [req.user.id, id]
    );

    return res.json({ token: rows[0] || null });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/documents/:id/token (protected)
 * Generates — or rotates — the caller's single token for this project.
 *
 * Because each user may hold at most one token per project, calling this again
 * overwrites the previous token (the old raw value stops working immediately).
 * The new raw token is returned ONCE in the response.
 */
async function generateProjectToken(req, res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid project id' });

    const access = await loadProjectAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Project not found' });
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'You do not have access to this project' });
    }

    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    const tokenName =
      req.body && req.body.name && String(req.body.name).trim()
        ? String(req.body.name).trim().slice(0, 100)
        : `${access.project.title} token`;

    // One token per (user, project): rotate in place on conflict.
    const { rows } = await db.query(
      `INSERT INTO api_tokens (user_id, project_id, token_hash, token_name, is_active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (user_id, project_id)
       DO UPDATE SET token_hash   = EXCLUDED.token_hash,
                     token_name   = EXCLUDED.token_name,
                     is_active    = TRUE,
                     last_used_at = NULL,
                     created_at   = CURRENT_TIMESTAMP
       RETURNING id, project_id, token_name, is_active, last_used_at, created_at`,
      [req.user.id, id, tokenHash, tokenName]
    );

    return res.status(201).json({
      // Surface the raw token exactly once — it cannot be retrieved later.
      token: rawToken,
      tokenInfo: rows[0],
      project: { id: access.project.id, title: access.project.title },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * DELETE /api/documents/:id/token (protected)
 * Revokes (deletes) the caller's token for this project.
 */
async function revokeProjectToken(req, res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid project id' });

    const { rowCount } = await db.query(
      `DELETE FROM api_tokens WHERE user_id = $1 AND project_id = $2`,
      [req.user.id, id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'No token found for this project' });
    }
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listTokens,
  getProjectToken,
  generateProjectToken,
  revokeProjectToken,
};
