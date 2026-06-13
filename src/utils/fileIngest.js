'use strict';

// Knowledge-base file ingestion shared by the web (multipart) and MCP (token)
// upload paths. Both hand us a Buffer + original filename; this module owns the
// validation, text extraction, chunking, embedding and persistence so the two
// entry points behave identically.

const { pool } = require('../config/db');
const { embedText, toVectorLiteral } = require('./embeddings');

// Only these file types may be ingested into a project's knowledge base.
const ALLOWED_EXTENSIONS = ['.md', '.txt', '.pdf'];
// Generous per-file ceiling; embedding cost grows with size so we cap it.
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

// Target size (characters) of each chunk, with a small overlap so meaning
// isn't lost at chunk boundaries during semantic search.
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 100;

function extOf(filename) {
  const m = /\.[^.\/\\]+$/.exec(String(filename || '').toLowerCase());
  return m ? m[0] : '';
}

function isAllowedFilename(filename) {
  return ALLOWED_EXTENSIONS.includes(extOf(filename));
}

// Bare type (without the dot) stored in document_files.file_type.
function fileTypeOf(filename) {
  return extOf(filename).replace(/^\./, '');
}

/**
 * Extract plain text from an uploaded file buffer.
 * @param {Buffer} buffer
 * @param {string} ext  Lower-cased extension including the dot (".pdf").
 * @returns {Promise<string>}
 */
async function extractText(buffer, ext) {
  if (ext === '.pdf') {
    // pdf-parse v2: construct with the buffer, then read text.
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return (result && result.text) || '';
    } finally {
      if (typeof parser.destroy === 'function') {
        await parser.destroy().catch(() => {});
      }
    }
  }
  // .txt and .md are plain UTF-8 text.
  return buffer.toString('utf8');
}

/**
 * Split text into overlapping chunks, preferring paragraph/sentence breaks.
 * @param {string} text
 * @returns {string[]}
 */
function chunkText(text) {
  const clean = String(text).replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      // Try to end on a natural boundary in the back half of the window.
      const slice = clean.slice(start, end);
      const boundary = Math.max(
        slice.lastIndexOf('\n\n'),
        slice.lastIndexOf('\n'),
        slice.lastIndexOf('. ')
      );
      if (boundary > CHUNK_SIZE * 0.5) end = start + boundary + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

/**
 * Validate, parse, chunk, embed and persist a single uploaded file.
 *
 * All chunk inserts plus the file record happen in one transaction so a
 * partially-embedded file never leaks into the knowledge base.
 *
 * @param {Object} opts
 * @param {string} opts.projectId     Target project (document) id.
 * @param {string} opts.userId        Acting user (recorded as uploaded_by).
 * @param {string} opts.apiKey        Acting user's OpenRouter key (plaintext).
 * @param {string} opts.model         Project's embedding model.
 * @param {string} opts.filename      Original filename (drives the type check).
 * @param {Buffer} opts.buffer        Raw file bytes.
 * @returns {Promise<Object>} The created document_files row.
 */
async function ingestFile({ projectId, userId, apiKey, model, filename, buffer }) {
  const ext = extOf(filename);
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    const err = new Error(
      `Unsupported file type "${ext || filename}". Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
    );
    err.status = 400;
    throw err;
  }
  if (!buffer || !buffer.length) {
    const err = new Error(`File "${filename}" is empty`);
    err.status = 400;
    throw err;
  }
  if (buffer.length > MAX_FILE_BYTES) {
    const err = new Error(
      `File "${filename}" is too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB)`
    );
    err.status = 413;
    throw err;
  }

  let text;
  try {
    text = await extractText(buffer, ext);
  } catch (parseErr) {
    const err = new Error(`Could not read "${filename}": ${parseErr.message}`);
    err.status = 422;
    throw err;
  }

  const chunks = chunkText(text);
  if (chunks.length === 0) {
    const err = new Error(`No readable text found in "${filename}"`);
    err.status = 422;
    throw err;
  }

  // Embed every chunk up front (network) before opening the transaction, so we
  // don't hold a DB connection open across slow OpenRouter calls.
  const vectors = [];
  for (const piece of chunks) {
    // eslint-disable-next-line no-await-in-loop
    vectors.push(await embedText({ apiKey, model, input: piece }));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const fileRes = await client.query(
      `INSERT INTO document_files (document_id, uploaded_by, filename, file_type, byte_size, chunk_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, document_id, uploaded_by, filename, file_type, byte_size, chunk_count, created_at`,
      [projectId, userId, filename, fileTypeOf(filename), buffer.length, chunks.length]
    );
    const file = fileRes.rows[0];

    // Continue chunk_index from whatever already exists on the project.
    const idxRes = await client.query(
      `SELECT COALESCE(MAX(chunk_index) + 1, 0) AS next FROM document_chunks WHERE document_id = $1`,
      [projectId]
    );
    let nextIndex = idxRes.rows[0].next;

    for (let i = 0; i < chunks.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO document_chunks
           (document_id, file_id, content, chunk_index, embedding, embedding_model)
         VALUES ($1, $2, $3, $4, $5::vector, $6)`,
        [projectId, file.id, chunks[i], nextIndex, toVectorLiteral(vectors[i]), model]
      );
      nextIndex += 1;
    }

    await client.query(
      `UPDATE documents SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [projectId]
    );

    await client.query('COMMIT');
    return file;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  ALLOWED_EXTENSIONS,
  MAX_FILE_BYTES,
  isAllowedFilename,
  extOf,
  chunkText,
  ingestFile,
};
