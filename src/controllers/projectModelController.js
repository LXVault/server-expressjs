'use strict';

const db = require('../config/db');
const { EMBEDDING_MODELS, isAllowedModel } = require('../utils/embeddings');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Load a project plus the caller's configuration rights.
 * Only the owner or a member with the 'admin' role may change the model.
 * @returns {Promise<{project: Object, canConfigure: boolean, hasAccess: boolean}|null>}
 */
async function loadModelAccess(projectId, userId) {
  const { rows } = await db.query(
    `SELECT d.id,
            d.title,
            d.embedding_model,
            (d.owner_id = $2) AS is_owner,
            (SELECT dm.role FROM document_members dm
              WHERE dm.document_id = d.id AND dm.user_id = $2) AS member_role
     FROM documents d
     WHERE d.id = $1`,
    [projectId, userId]
  );
  if (!rows[0]) return null;
  const { is_owner: isOwner, member_role: memberRole, ...project } = rows[0];
  const canConfigure = isOwner || memberRole === 'admin';
  const hasAccess = isOwner || Boolean(memberRole);
  return { project, canConfigure, hasAccess };
}

/**
 * GET /api/documents/:id/embedding-model (protected)
 * Returns the project's current model, the selectable list, and whether the
 * caller may change it.
 */
async function getEmbeddingModel(req, res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid project id' });

    const access = await loadModelAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Project not found' });
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'You do not have access to this project' });
    }

    return res.json({
      model: access.project.embedding_model,
      models: EMBEDDING_MODELS,
      canConfigure: access.canConfigure,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * PUT /api/documents/:id/embedding-model (protected, owner/admin only)
 * Body: { model }
 */
async function setEmbeddingModel(req, res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid project id' });

    const { model } = req.body || {};
    if (!model || !isAllowedModel(model)) {
      return res.status(400).json({
        error: `model must be one of: ${EMBEDDING_MODELS.join(', ')}`,
      });
    }

    const access = await loadModelAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Project not found' });
    if (!access.canConfigure) {
      return res.status(403).json({
        error: 'Only the project owner or an admin can change the embedding model',
      });
    }

    const { rows } = await db.query(
      `UPDATE documents
       SET embedding_model = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, embedding_model`,
      [id, model]
    );

    return res.json({ model: rows[0].embedding_model, models: EMBEDDING_MODELS });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getEmbeddingModel, setEmbeddingModel };
