'use strict';

// Knowledge-base file ingestion shared by the web (multipart) and MCP (token)
// upload paths. Both hand us a Buffer + original filename; this module owns the
// validation, text extraction, chunking, embedding and persistence so the two
// entry points behave identically.

const { pool } = require('../config/db');
const { embedText, toVectorLiteral, normalizeModelName } = require('./embeddings');

// Only these file types may be ingested into a project's knowledge base.
const ALLOWED_EXTENSIONS = ['.md', '.txt', '.pdf'];
// Generous per-file ceiling; embedding cost grows with size so we cap it.
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

// Ceiling on how many chunks one file may produce, and therefore on how many
// embedding calls one upload may make. `MAX_FILE_BYTES` bounds the input but
// not the work: 10 MB of dense text chunks into roughly 11,000 pieces, and the
// loop below embeds them one at a time, sequentially, spending the caller's
// OpenRouter credits and holding a database transaction open for the duration.
// This is the check that turns that request into a refusal instead.
//
// 2000 is a judgement call, not a measured value: at ~1000 characters a chunk
// that is roughly a 2 MB text file or a 300-page PDF, which covers the documents
// this product is for. Raise it if real uploads are being rejected.
const MAX_CHUNKS_PER_FILE = 2000;

// How long PDF text extraction may run before the file is rejected. Parsing is
// pure CPU on an attacker-supplied buffer, so an unbounded parse is a way to
// occupy a request slot indefinitely.
const PDF_PARSE_TIMEOUT_MS = 15_000;

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
    // The deadline is a promise, not an abort: pdf-parse exposes no way to
    // cancel an in-flight parse. Racing it means the request is released and the
    // parser is destroyed, even though its work may run on in the background for
    // a while. That is the trade for not holding the slot open indefinitely.
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`PDF parsing exceeded ${PDF_PARSE_TIMEOUT_MS}ms`)),
        PDF_PARSE_TIMEOUT_MS
      );
    });
    try {
      const result = await Promise.race([parser.getText(), deadline]);
      return (result && result.text) || '';
    } finally {
      clearTimeout(timer);
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
    // The parser's own message carries byte offsets, object counts and
    // occasionally a fragment of the file, none of which the caller needs and
    // some of which describe the internals of a parser fed attacker-controlled
    // bytes. The real message is logged by whoever handles this error.
    console.error(`[ingest] "${filename}" could not be parsed: ${parseErr.message}`);
    const err = new Error(`Could not read "${filename}" as text`);
    err.status = 422;
    throw err;
  }

  const chunks = chunkText(text);
  if (chunks.length === 0) {
    const err = new Error(`No readable text found in "${filename}"`);
    err.status = 422;
    throw err;
  }

  // Checked before the model is resolved and before the embedding loop below,
  // which is the whole point: by the time a file is over the cap, the only
  // thing that has happened is a chunk count.
  if (chunks.length > MAX_CHUNKS_PER_FILE) {
    const err = new Error(
      `"${filename}" produces ${chunks.length} chunks, over the limit of ` +
        `${MAX_CHUNKS_PER_FILE}. Split it into smaller files, or remove the ` +
        'repetition that is padding it out.'
    );
    err.status = 413;
    throw err;
  }

  // Canonical spelling for the model_name column, decided once and used for
  // every row this ingestion writes.
  const modelName = normalizeModelName(model);
  if (!modelName) {
    const err = new Error(`Invalid embedding model id: ${model}`);
    err.status = 400;
    throw err;
  }

  // Embed every chunk up front (network) before opening the transaction, so we
  // don't hold a DB connection open across slow OpenRouter calls.
  const vectors = [];
  for (const piece of chunks) {
    // eslint-disable-next-line no-await-in-loop
    vectors.push(await embedText({ apiKey, model: modelName, input: piece }));
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

    // Content and vector are two rows now. The chunk is the durable record; the
    // embedding is one model's view of it, and a later model adds a row here
    // rather than replacing anything.
    for (let i = 0; i < chunks.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const chunkRes = await client.query(
        `INSERT INTO document_chunks (document_id, file_id, content, chunk_index)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [projectId, file.id, chunks[i], nextIndex]
      );

      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO document_chunk_embeddings (chunk_id, model_name, embedding, dimensions)
         VALUES ($1, $2, $3::vector, $4)
         ON CONFLICT (chunk_id, model_name) DO NOTHING`,
        [chunkRes.rows[0].id, modelName, toVectorLiteral(vectors[i]), vectors[i].length]
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
  MAX_CHUNKS_PER_FILE,
  PDF_PARSE_TIMEOUT_MS,
  isAllowedFilename,
  extOf,
  chunkText,
  extractText,
  ingestFile,
};
