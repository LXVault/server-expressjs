'use strict';

// How much of a project's knowledge base is actually searchable with a given
// embedding model.
//
// Since a chunk carries one vector per model, "how many chunks does this
// project have" and "how many can this model search" are different questions.
// Search silently returns nothing for a chunk with no row for the current
// model, so both numbers have to be reported or an uncovered knowledge base
// looks identical to an empty one.

const db = require('../config/db');

/**
 * Count a project's chunks and how many are embedded with one model.
 *
 * @param {string} projectId
 * @param {string|null} modelName  Canonical model name, already normalized.
 * @param {Object} [runner]        A pool client, when inside a transaction.
 * @returns {Promise<{model: string|null, total: number, embedded: number, pending: number}>}
 */
async function getCoverage(projectId, modelName, runner) {
  const client = runner || db;
  const { rows } = await client.query(
    `SELECT COUNT(c.id)::int AS total,
            COUNT(e.chunk_id)::int AS embedded
       FROM document_chunks c
       LEFT JOIN document_chunk_embeddings e
              ON e.chunk_id = c.id AND e.model_name = $2
      WHERE c.document_id = $1`,
    [projectId, modelName]
  );

  const total = rows[0] ? rows[0].total : 0;
  const embedded = rows[0] ? rows[0].embedded : 0;
  return { model: modelName, total, embedded, pending: total - embedded };
}

/**
 * Every model this project already holds vectors for, with a chunk count each.
 *
 * This is what makes a model switch reversible in the UI: a model listed here
 * is one the project can go back to without re-embedding anything.
 *
 * @param {string} projectId
 * @returns {Promise<Array<{model_name: string, chunks: number}>>}
 */
async function listStoredModels(projectId) {
  const { rows } = await db.query(
    `SELECT e.model_name, COUNT(*)::int AS chunks
       FROM document_chunk_embeddings e
       JOIN document_chunks c ON c.id = e.chunk_id
      WHERE c.document_id = $1
      GROUP BY e.model_name
      ORDER BY chunks DESC, e.model_name ASC`,
    [projectId]
  );
  return rows;
}

module.exports = { getCoverage, listStoredModels };
