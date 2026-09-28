'use strict';

const db = require('../config/db');
const { recordAudit } = require('../utils/audit');
const { ingestFile, ALLOWED_EXTENSIONS } = require('../utils/fileIngest');
const { getDecryptedOpenRouterKey } = require('../utils/userKeys');
const { isUuid, loadAccess } = require('../utils/documentAccess');

const NO_KEY_MESSAGE =
  'No OpenRouter API key configured for your account. Add your own key in the ' +
  'web app (Profile → OpenRouter API key) before uploading files.';

/**
 * Reduce an ingestion failure to something safe to hand back.
 *
 * Every branch here is a message this repository writes. The underlying error
 * is logged by the caller and never forwarded, because it may have been written
 * by the PDF parser or by OpenRouter, and both put things in their error
 * strings that are not the caller's to read.
 *
 * @param {Error & {status?: number}} err
 * @returns {string}
 */
function describeIngestFailure(err) {
  // Set by src/utils/embeddings.js so a rejected key can be named without
  // forwarding the upstream's own explanation of why.
  if (err.code === 'UPSTREAM_KEY_REJECTED') {
    return 'OpenRouter rejected your API key — check the key in your profile';
  }
  switch (err.status) {
    case 400:
      return 'the file type or contents are not supported';
    case 412:
      return 'your OpenRouter API key is not available';
    case 413:
      return 'the file is too large, or produces too many chunks';
    case 422:
      return 'the file could not be read as text';
    case 502:
      return 'the embedding provider could not be reached';
    default:
      return 'the file could not be processed';
  }
}

/**
 * GET /api/documents/:id/files (protected)
 * The project's "central index": every source file the knowledge base was built
 * from, with its chunk count. Visible to any member; managing requires canEdit.
 */
async function listFiles(req, res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid document id' });

    const access = await loadAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Document not found' });
    if (!access.isOwner && !access.isMember) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    const { rows } = await db.query(
      `SELECT f.id,
              f.filename,
              f.file_type,
              f.byte_size,
              f.chunk_count,
              f.created_at,
              u.username AS uploaded_by
       FROM document_files f
       LEFT JOIN users u ON u.id = f.uploaded_by
       WHERE f.document_id = $1
       ORDER BY f.created_at DESC`,
      [id]
    );

    return res.json({ files: rows, total: rows.length, canManage: access.canEdit });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/documents/:id/files (protected, owner/admin only)
 * Multipart upload of one or more files (field name: "files"). Each file is
 * parsed, chunked, embedded with the caller's OpenRouter key and stored.
 */
async function uploadFiles(req, res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid document id' });

    // `requireDocumentWrite` has already resolved and checked this, before
    // multer was allowed to buffer anything. Reuse its result rather than
    // repeating the query; fall back to a fresh lookup if the controller is
    // ever reached without the middleware in front of it.
    const access = req.documentAccess || (await loadAccess(id, req.user.id));
    if (!access) return res.status(404).json({ error: 'Document not found' });
    if (!access.canEdit) {
      return res.status(403).json({
        error: 'Only the project owner, or an editor or admin, can upload files',
      });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({
        error: `No files received. Attach one or more ${ALLOWED_EXTENSIONS.join(', ')} files.`,
      });
    }

    const apiKey = await getDecryptedOpenRouterKey(req.user.id);
    if (!apiKey) return res.status(412).json({ error: NO_KEY_MESSAGE });

    const model = access.document.embedding_model;

    // Ingest each file independently; report per-file success/failure so one
    // bad file in a batch doesn't discard the others.
    const uploaded = [];
    const failed = [];
    for (const file of files) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const record = await ingestFile({
          projectId: id,
          userId: req.user.id,
          apiKey,
          model,
          filename: file.originalname,
          buffer: file.buffer,
        });
        uploaded.push(record);
        // eslint-disable-next-line no-await-in-loop
        await recordAudit({
          userId: req.user.id,
          actionType: 'documents.upload_file',
          resourceTable: 'document_files',
          resourceId: record.id,
          details: { filename: record.filename, chunks: record.chunk_count, model },
        });
      } catch (fileErr) {
        // Logged in full, returned in reduced form. A failure inside ingestFile
        // can have come from the PDF parser or from OpenRouter, and their
        // messages carry file offsets, upstream status codes and occasionally
        // an upstream error body. None of that is the caller's to see, and
        // echoing it turned this response into a way to read an upstream's
        // internals. The `error` field keeps its name — the web app reads it —
        // and now carries this application's own wording.
        console.error(`[upload] "${file.originalname}" failed: ${fileErr.message}`);
        failed.push({
          filename: file.originalname,
          error: describeIngestFailure(fileErr),
        });
      }
    }

    if (uploaded.length === 0) {
      const reasons = failed.map((f) => `${f.filename}: ${f.error}`).join('; ');
      return res.status(422).json({
        error: `No files could be ingested — ${reasons}`,
        failed,
      });
    }

    return res.status(201).json({ files: uploaded, failed });
  } catch (err) {
    return next(err);
  }
}

/**
 * DELETE /api/documents/:id/files/:fileId (protected, owner/admin only)
 * Removes a file and (via ON DELETE CASCADE) all of its knowledge chunks.
 */
async function deleteFile(req, res, next) {
  try {
    const { id, fileId } = req.params;
    if (!isUuid(id) || !isUuid(fileId)) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const access = await loadAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Document not found' });
    if (!access.canEdit) {
      return res.status(403).json({
        error: 'Only the project owner or an admin can delete files',
      });
    }

    const { rows } = await db.query(
      `DELETE FROM document_files
       WHERE id = $1 AND document_id = $2
       RETURNING id, filename, chunk_count`,
      [fileId, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'File not found on this project' });
    }

    await recordAudit({
      userId: req.user.id,
      actionType: 'documents.delete_file',
      resourceTable: 'document_files',
      resourceId: fileId,
      details: { filename: rows[0].filename, chunks: rows[0].chunk_count },
    });

    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

module.exports = { listFiles, uploadFiles, deleteFile };
