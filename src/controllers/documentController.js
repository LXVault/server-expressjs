'use strict';

const db = require('../config/db');

/**
 * GET /api/documents (protected)
 * Lists documents the user owns or is a member of, with chunk counts.
 */
async function listDocuments(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT d.id,
              d.title,
              d.summary,
              d.owner_id,
              (d.owner_id = $1) AS is_owner,
              COALESCE(dm.role, 'owner') AS role,
              d.created_at,
              d.updated_at,
              COUNT(dc.id)::int AS chunk_count
       FROM documents d
       LEFT JOIN document_members dm
              ON dm.document_id = d.id AND dm.user_id = $1
       LEFT JOIN document_chunks dc
              ON dc.document_id = d.id
       WHERE d.owner_id = $1 OR dm.user_id = $1
       GROUP BY d.id, dm.role
       ORDER BY d.updated_at DESC`,
      [req.user.id]
    );

    return res.json({ documents: rows, total: rows.length });
  } catch (err) {
    return next(err);
  }
}

module.exports = { listDocuments };
