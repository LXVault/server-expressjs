'use strict';

const db = require('../config/db');
const { pool } = db;
const { recordAudit } = require('../utils/audit');
const {
  EMBEDDING_MODELS,
  isConventionalModelId,
  normalizeModelName,
  embedText,
  toVectorLiteral,
} = require('../utils/embeddings');
const { getCoverage, listStoredModels } = require('../utils/embeddingCoverage');
const { getDecryptedOpenRouterKey } = require('../utils/userKeys');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ceiling on one backfill request. Each chunk costs a round trip to OpenRouter,
// so an unbounded call on a large project would hold the connection open for
// minutes and time out behind a proxy. The response reports what is left, and
// the caller repeats until nothing is pending.
const BACKFILL_BATCH_LIMIT = 100;

const NO_KEY_MESSAGE =
  'No OpenRouter API key configured for your account. Add your own key in the ' +
  'web app (Profile → OpenRouter API key) before generating embeddings.';

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
 * Assemble the model payload shared by the read and write endpoints: the
 * selected model, how much of the knowledge base that model can search, and
 * every model the project already holds vectors for.
 *
 * The stored list is what makes a switch legible as reversible: a model in it
 * can be returned to at no cost, because its vectors were never discarded.
 */
async function buildModelPayload(projectId, selectedModel) {
  const model = normalizeModelName(selectedModel);
  const [coverage, storedModels] = await Promise.all([
    getCoverage(projectId, model),
    listStoredModels(projectId),
  ]);

  return {
    model,
    models: EMBEDDING_MODELS,
    coverage: {
      total: coverage.total,
      embedded: coverage.embedded,
      pending: coverage.pending,
    },
    storedModels,
  };
}

/**
 * GET /api/documents/:id/embedding-model (protected)
 * Returns the project's current model, its coverage, the models already
 * embedded, the selectable list, and whether the caller may change it.
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

    const payload = await buildModelPayload(id, access.project.embedding_model);
    return res.json({ ...payload, canConfigure: access.canConfigure });
  } catch (err) {
    return next(err);
  }
}

/**
 * PUT /api/documents/:id/embedding-model (protected, owner/admin only)
 * Body: { model }
 *
 * Changing the model is non-destructive: nothing already embedded is deleted,
 * so switching back is free. Chunks with no vector for the new model are simply
 * not searchable yet, which the returned coverage reports.
 */
async function setEmbeddingModel(req, res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid project id' });

    const requested = req.body && typeof req.body.model === 'string' ? req.body.model : '';
    if (!isConventionalModelId(requested)) {
      return res.status(400).json({
        error:
          'model must be a provider-namespaced OpenRouter model id of the form ' +
          'platform/model, for example openai/text-embedding-3-small',
      });
    }
    // Lower-cased before the write, so one model never gains a second spelling.
    const model = normalizeModelName(requested);

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

    await recordAudit({
      userId: req.user.id,
      actionType: 'documents.set_embedding_model',
      resourceTable: 'documents',
      resourceId: id,
      details: { from: normalizeModelName(access.project.embedding_model), to: model },
    });

    const payload = await buildModelPayload(id, rows[0].embedding_model);
    return res.json({ ...payload, canConfigure: true });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/documents/:id/embeddings/backfill (protected, owner/admin only)
 *
 * Embeds the chunks that have no vector for the project's current model, using
 * the caller's own OpenRouter key. Idempotent and resumable: it only ever adds
 * rows, and it stops at BACKFILL_BATCH_LIMIT so a large project is covered by
 * repeating the call rather than by one request that never returns.
 */
async function backfillEmbeddings(req, res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid project id' });

    const access = await loadModelAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Project not found' });
    if (!access.canConfigure) {
      return res.status(403).json({
        error: 'Only the project owner or an admin can generate embeddings',
      });
    }

    const model = normalizeModelName(access.project.embedding_model);
    if (!model) {
      return res.status(400).json({
        error: 'This project has no usable embedding model set',
      });
    }

    const apiKey = await getDecryptedOpenRouterKey(req.user.id);
    if (!apiKey) return res.status(412).json({ error: NO_KEY_MESSAGE });

    const { rows: pending } = await db.query(
      `SELECT c.id, c.content
         FROM document_chunks c
         LEFT JOIN document_chunk_embeddings e
                ON e.chunk_id = c.id AND e.model_name = $2
        WHERE c.document_id = $1
          AND e.chunk_id IS NULL
        ORDER BY c.chunk_index ASC
        LIMIT $3`,
      [id, model, BACKFILL_BATCH_LIMIT]
    );

    // Embed outside any transaction: these are slow network calls and holding a
    // connection across them is what the ingestion path already avoids.
    const embedded = [];
    const failed = [];
    for (const chunk of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const vector = await embedText({ apiKey, model, input: chunk.content });
        embedded.push({ id: chunk.id, vector });
      } catch (embedErr) {
        // Record and stop. A repeated failure is usually the key or the model,
        // so continuing would spend the user's credits on the same error.
        failed.push({ id: chunk.id, error: embedErr.message });
        break;
      }
    }

    if (embedded.length > 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of embedded) {
          // eslint-disable-next-line no-await-in-loop
          await client.query(
            `INSERT INTO document_chunk_embeddings (chunk_id, model_name, embedding, dimensions)
             VALUES ($1, $2, $3::vector, $4)
             ON CONFLICT (chunk_id, model_name) DO NOTHING`,
            [row.id, model, toVectorLiteral(row.vector), row.vector.length]
          );
        }
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
    }

    await recordAudit({
      userId: req.user.id,
      actionType: 'documents.backfill_embeddings',
      resourceTable: 'documents',
      resourceId: id,
      details: { model, embedded: embedded.length, failed: failed.length },
    });

    const payload = await buildModelPayload(id, model);

    // Nothing embedded and something failed means the first call already broke,
    // so report the reason rather than a success with a zero count.
    if (embedded.length === 0 && failed.length > 0) {
      return res.status(502).json({
        error: `Could not generate embeddings: ${failed[0].error}`,
        ...payload,
      });
    }

    return res.json({
      embedded: embedded.length,
      failed,
      ...payload,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * DELETE /api/documents/:id/embeddings/:model (protected, owner/admin only)
 *
 * Drops every vector a project holds for one model. Nothing does this on its
 * own: a model switch keeps the old vectors precisely so it can be undone, and
 * reclaiming that space is a deliberate act. The model currently selected
 * cannot be dropped, since that would leave the project unsearchable.
 */
async function deleteModelEmbeddings(req, res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid project id' });

    const model = normalizeModelName(req.params.model);
    if (!model) return res.status(400).json({ error: 'Invalid model name' });

    const access = await loadModelAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Project not found' });
    if (!access.canConfigure) {
      return res.status(403).json({
        error: 'Only the project owner or an admin can delete embeddings',
      });
    }

    if (model === normalizeModelName(access.project.embedding_model)) {
      return res.status(409).json({
        error:
          'That model is the one this project currently searches with. Select a ' +
          'different model first if you want to remove its embeddings.',
      });
    }

    const { rowCount } = await db.query(
      `DELETE FROM document_chunk_embeddings e
        USING document_chunks c
        WHERE e.chunk_id = c.id
          AND c.document_id = $1
          AND e.model_name = $2`,
      [id, model]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'This project holds no embeddings for that model' });
    }

    await recordAudit({
      userId: req.user.id,
      actionType: 'documents.delete_model_embeddings',
      resourceTable: 'document_chunk_embeddings',
      resourceId: id,
      details: { model, removed: rowCount },
    });

    const payload = await buildModelPayload(id, access.project.embedding_model);
    return res.json({ removed: rowCount, ...payload });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getEmbeddingModel,
  setEmbeddingModel,
  backfillEmbeddings,
  deleteModelEmbeddings,
  BACKFILL_BATCH_LIMIT,
};
