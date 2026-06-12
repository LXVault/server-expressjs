'use strict';

const db = require('../config/db');
const { recordAudit } = require('../utils/audit');

/**
 * GET /api/mcp/me  (API-token auth)
 * Identifies the user and project the presented token is bound to. This is the
 * primary "who am I executing as" probe used by the MCP server.
 */
async function me(req, res, next) {
  try {
    const { tokenId, userId, username, projectId, projectTitle } = req.apiToken;

    await recordAudit({
      userId,
      tokenId,
      actionType: 'mcp.whoami',
      resourceTable: 'documents',
      resourceId: projectId,
    });

    return res.json({
      user: { id: userId, username },
      project: { id: projectId, title: projectTitle },
      tokenId,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/mcp/project  (API-token auth)
 * Returns details about the project the token grants access to, including a
 * chunk count so the agent knows how much knowledge is available.
 */
async function getProject(req, res, next) {
  try {
    const { tokenId, userId, projectId } = req.apiToken;

    const { rows } = await db.query(
      `SELECT d.id,
              d.title,
              d.summary,
              d.created_at,
              d.updated_at,
              COUNT(dc.id)::int AS chunk_count
       FROM documents d
       LEFT JOIN document_chunks dc ON dc.document_id = d.id
       WHERE d.id = $1
       GROUP BY d.id`,
      [projectId]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Project not found' });

    await recordAudit({
      userId,
      tokenId,
      actionType: 'mcp.get_project',
      resourceTable: 'documents',
      resourceId: projectId,
    });

    return res.json({ project: rows[0] });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/mcp/search  (API-token auth)
 * Body: { query, limit? }
 * Simple text search across the project's knowledge-base chunks. Every search
 * is audited against the acting user + token so executions are fully traceable.
 */
async function search(req, res, next) {
  try {
    const { tokenId, userId, projectId } = req.apiToken;
    const { query, limit } = req.body || {};

    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    const max = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 25);
    const term = String(query).trim();

    const { rows } = await db.query(
      `SELECT id, chunk_index, content
       FROM document_chunks
       WHERE document_id = $1
         AND content ILIKE '%' || $2 || '%'
       ORDER BY chunk_index ASC
       LIMIT $3`,
      [projectId, term, max]
    );

    await recordAudit({
      userId,
      tokenId,
      actionType: 'mcp.search',
      resourceTable: 'documents',
      resourceId: projectId,
      details: { query: term, results: rows.length },
    });

    return res.json({ query: term, results: rows, total: rows.length });
  } catch (err) {
    return next(err);
  }
}

module.exports = { me, getProject, search };
