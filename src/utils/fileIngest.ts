// Knowledge-base file ingestion shared by the web (multipart) and MCP (token)
// upload paths. Both hand us a Buffer + original filename; this module owns the
// validation, text extraction, chunking, embedding and persistence so the two
// entry points behave identically.

import { pool } from '../config/db.js';
import { embedText, toVectorLiteral, normalizeModelName } from './embeddings.js';
import { httpError } from '../types/http.js';

/** Arguments to {@link ingestFile}. */
export interface IngestRequest {
  /** Target project (document) id. */
  projectId: string;
  /** Acting user (recorded as uploaded_by). */
  userId: string;
  /** Acting user's OpenRouter key (plaintext). */
  apiKey: string;
  /** Project's embedding model. */
  model: string | null;
  /** Original filename (drives the type check). */
  filename: string;
  /** Raw file bytes. */
  buffer: Buffer;
}

/** A `document_files` row as returned by the insert below. */
export interface DocumentFileRow {
  id: string;
  document_id: string;
  uploaded_by: string;
  filename: string;
  file_type: string;
  byte_size: number;
  chunk_count: number;
  created_at: Date;
}

// Only these file types may be ingested into a project's knowledge base.
export const ALLOWED_EXTENSIONS: readonly string[] = ['.md', '.txt', '.pdf'];
// Generous per-file ceiling; embedding cost grows with size so we cap it.
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

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
export const MAX_CHUNKS_PER_FILE = 2000;

// How long PDF text extraction may run before the file is rejected. Parsing is
// pure CPU on an attacker-supplied buffer, so an unbounded parse is a way to
// occupy a request slot indefinitely.
export const PDF_PARSE_TIMEOUT_MS = 15_000;

// Target size (characters) of each chunk, with a small overlap so meaning
// isn't lost at chunk boundaries during semantic search.
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 100;

export function extOf(filename: unknown): string {
  const m = /\.[^.\/\\]+$/.exec(String(filename || '').toLowerCase());
  return m ? m[0] : '';
}

export function isAllowedFilename(filename: unknown): boolean {
  return ALLOWED_EXTENSIONS.includes(extOf(filename));
}

// Bare type (without the dot) stored in document_files.file_type.
function fileTypeOf(filename: string): string {
  return extOf(filename).replace(/^\./, '');
}

/**
 * Extract plain text from an uploaded file buffer.
 * @param buffer
 * @param ext  Lower-cased extension including the dot (".pdf").
 */
export async function extractText(buffer: Buffer, ext: string): Promise<string> {
  if (ext === '.pdf') {
    // pdf-parse v2: construct with the buffer, then read text. Loaded on first
    // use rather than at boot, as before, so a process that never sees a PDF
    // never loads the parser.
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    // The deadline is a promise, not an abort: pdf-parse exposes no way to
    // cancel an in-flight parse. Racing it means the request is released and the
    // parser is destroyed, even though its work may run on in the background for
    // a while. That is the trade for not holding the slot open indefinitely.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
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
 */
export function chunkText(text: unknown): string[] {
  const clean = String(text).replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const chunks: string[] = [];
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
 * @returns The created document_files row.
 */
export async function ingestFile({
  projectId,
  userId,
  apiKey,
  model,
  filename,
  buffer,
}: IngestRequest): Promise<DocumentFileRow> {
  const ext = extOf(filename);
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw httpError(
      `Unsupported file type "${ext || filename}". Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
      400
    );
  }
  if (!buffer || !buffer.length) {
    throw httpError(`File "${filename}" is empty`, 400);
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw httpError(
      `File "${filename}" is too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB)`,
      413
    );
  }

  let text: string;
  try {
    text = await extractText(buffer, ext);
  } catch (parseErr) {
    // The parser's own message carries byte offsets, object counts and
    // occasionally a fragment of the file, none of which the caller needs and
    // some of which describe the internals of a parser fed attacker-controlled
    // bytes. The real message is logged by whoever handles this error.
    console.error(`[ingest] "${filename}" could not be parsed: ${(parseErr as Error).message}`);
    throw httpError(`Could not read "${filename}" as text`, 422);
  }

  const chunks = chunkText(text);
  if (chunks.length === 0) {
    throw httpError(`No readable text found in "${filename}"`, 422);
  }

  // Checked before the model is resolved and before the embedding loop below,
  // which is the whole point: by the time a file is over the cap, the only
  // thing that has happened is a chunk count.
  if (chunks.length > MAX_CHUNKS_PER_FILE) {
    throw httpError(
      `"${filename}" produces ${chunks.length} chunks, over the limit of ` +
        `${MAX_CHUNKS_PER_FILE}. Split it into smaller files, or remove the ` +
        'repetition that is padding it out.',
      413
    );
  }

  // Canonical spelling for the model_name column, decided once and used for
  // every row this ingestion writes.
  const modelName = normalizeModelName(model);
  if (!modelName) {
    throw httpError(`Invalid embedding model id: ${model}`, 400);
  }

  // Embed every chunk up front (network) before opening the transaction, so we
  // don't hold a DB connection open across slow OpenRouter calls.
  const vectors: number[][] = [];
  for (const piece of chunks) {
    // eslint-disable-next-line no-await-in-loop
    vectors.push(await embedText({ apiKey, model: modelName, input: piece }));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const fileRes = await client.query<DocumentFileRow>(
      `INSERT INTO document_files (document_id, uploaded_by, filename, file_type, byte_size, chunk_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, document_id, uploaded_by, filename, file_type, byte_size, chunk_count, created_at`,
      [projectId, userId, filename, fileTypeOf(filename), buffer.length, chunks.length]
    );
    const file = fileRes.rows[0];

    // Continue chunk_index from whatever already exists on the project.
    const idxRes = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(chunk_index) + 1, 0) AS next FROM document_chunks WHERE document_id = $1`,
      [projectId]
    );
    let nextIndex = idxRes.rows[0].next;

    // Content and vector are two rows now. The chunk is the durable record; the
    // embedding is one model's view of it, and a later model adds a row here
    // rather than replacing anything.
    for (let i = 0; i < chunks.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const chunkRes = await client.query<{ id: string }>(
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
