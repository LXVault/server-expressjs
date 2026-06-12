'use strict';

const db = require('../config/db');

/**
 * GET /api/analysis (protected)
 * Aggregates metrics over the documents the user can access:
 *   - totalDocuments, totalChunks
 *   - chunksPerDocument  -> bar chart data
 *   - roleDistribution   -> pie chart data
 */
async function getAnalysis(req, res, next) {
  try {
    const userId = req.user.id;

    // Documents the user owns or is a member of.
    const accessibleDocsCte = `
      WITH accessible_docs AS (
        SELECT d.id, d.title
        FROM documents d
        LEFT JOIN document_members dm
               ON dm.document_id = d.id AND dm.user_id = $1
        WHERE d.owner_id = $1 OR dm.user_id = $1
      )`;

    // Per-document chunk counts (bar chart).
    const perDocResult = await db.query(
      `${accessibleDocsCte}
       SELECT ad.id AS document_id,
              ad.title,
              COUNT(dc.id)::int AS chunk_count
       FROM accessible_docs ad
       LEFT JOIN document_chunks dc ON dc.document_id = ad.id
       GROUP BY ad.id, ad.title
       ORDER BY chunk_count DESC, ad.title ASC`,
      [userId]
    );

    // Role distribution across members of accessible documents (pie chart).
    const roleResult = await db.query(
      `${accessibleDocsCte}
       SELECT dm.role, COUNT(*)::int AS count
       FROM document_members dm
       JOIN accessible_docs ad ON ad.id = dm.document_id
       GROUP BY dm.role
       ORDER BY count DESC`,
      [userId]
    );

    const chunksPerDocument = perDocResult.rows;
    const totalDocuments = chunksPerDocument.length;
    const totalChunks = chunksPerDocument.reduce((sum, d) => sum + d.chunk_count, 0);

    return res.json({
      totalDocuments,
      totalChunks,
      chunksPerDocument,
      roleDistribution: roleResult.rows,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getAnalysis };
