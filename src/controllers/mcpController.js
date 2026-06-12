'use strict';

const db = require('../config/db');
const { recordAudit } = require('../utils/audit');
const { embedText, toVectorLiteral } = require('../utils/embeddings');
const { getDecryptedOpenRouterKey } = require('../utils/userKeys');

const NO_KEY_MESSAGE =
  'No OpenRouter API key configured for your account. Add your own key in the ' +
  'web app (Profile → OpenRouter API key) before using semantic search.';

/**
 * Fetch a project's currently selected embedding model.
 * @returns {Promise<string|null>}
 */
async function getProjectModel(projectId) {
  const { rows } = await db.query(
    `SELECT embedding_model FROM documents WHERE id = $1`,
    [projectId]
  );
  return rows[0] ? rows[0].embedding_model : null;
}

/**
 * GET /api/mcp/me  (API-token auth)
 * Identifies the user and project the presented token is bound to.
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
 * Returns details about the project the token grants access to, including its
 * selected embedding model and a chunk count.
 */
async function getProject(req, res, next) {
  try {
    const { tokenId, userId, projectId } = req.apiToken;

    const { rows } = await db.query(
      `SELECT d.id,
              d.title,
              d.summary,
              d.embedding_model,
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
 * Semantic search: embeds the query with the project's model (using the acting
 * user's own OpenRouter key) and ranks chunks by cosine similarity. Audited.
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

    const apiKey = await getDecryptedOpenRouterKey(userId);
    if (!apiKey) return res.status(412).json({ error: NO_KEY_MESSAGE });

    const model = await getProjectModel(projectId);
    const queryVector = await embedText({ apiKey, model, input: term });

    // Exact KNN by cosine distance; only compare chunks embedded with the
    // project's current model so dimensions always match.
    const { rows } = await db.query(
      `SELECT id, chunk_index, content,
              1 - (embedding <=> $2::vector) AS score
       FROM document_chunks
       WHERE document_id = $1
         AND embedding IS NOT NULL
         AND embedding_model = $3
       ORDER BY embedding <=> $2::vector
       LIMIT $4`,
      [projectId, toVectorLiteral(queryVector), model, max]
    );

    await recordAudit({
      userId,
      tokenId,
      actionType: 'mcp.search',
      resourceTable: 'documents',
      resourceId: projectId,
      details: { query: term, model, results: rows.length },
    });

    return res.json({ query: term, model, results: rows, total: rows.length });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/mcp/knowledge  (API-token auth)
 * Body: { content }
 * Embeds the text with the project's model (using the acting user's OpenRouter
 * key) and stores it as a new chunk. Audited against the acting user + token.
 */
async function addKnowledge(req, res, next) {
  try {
    const { tokenId, userId, projectId } = req.apiToken;
    const { content } = req.body || {};

    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: 'content is required' });
    }
    const text = String(content).trim();

    const apiKey = await getDecryptedOpenRouterKey(userId);
    if (!apiKey) return res.status(412).json({ error: NO_KEY_MESSAGE });

    const model = await getProjectModel(projectId);
    const vector = await embedText({ apiKey, model, input: text });

    const { rows } = await db.query(
      `INSERT INTO document_chunks (document_id, content, chunk_index, embedding, embedding_model)
       VALUES (
         $1,
         $2,
         COALESCE(
           (SELECT MAX(chunk_index) + 1 FROM document_chunks WHERE document_id = $1),
           0
         ),
         $3::vector,
         $4
       )
       RETURNING id, chunk_index, content, embedding_model, created_at`,
      [projectId, text, toVectorLiteral(vector), model]
    );

    const chunk = rows[0];

    await recordAudit({
      userId,
      tokenId,
      actionType: 'mcp.add_knowledge',
      resourceTable: 'document_chunks',
      resourceId: chunk.id,
      details: { chunk_index: chunk.chunk_index, model, length: text.length },
    });

    return res.status(201).json({ chunk });
  } catch (err) {
    return next(err);
  }
}

module.exports = { me, getProject, search, addKnowledge };
