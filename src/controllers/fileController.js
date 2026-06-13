'use strict';

const db = require('../config/db');
const { recordAudit } = require('../utils/audit');
const { ingestFile, ALLOWED_EXTENSIONS } = require('../utils/fileIngest');
const { getDecryptedOpenRouterKey } = require('../utils/userKeys');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

const NO_KEY_MESSAGE =
  'No OpenRouter API key configured for your account. Add your own key in the ' +
  'web app (Profile → OpenRouter API key) before uploading files.';

/**
 * Resolve a document and the caller's relationship to it.
 * `canEdit` is true for the owner or a member with the 'admin' role — the only
 * roles permitted to upload or delete knowledge files.
 */
async function loadAccess(documentId, userId) {
  const { rows } = await db.query(
    `SELECT d.id,
            d.owner_id,
            d.embedding_model,
            (d.owner_id = $2) AS is_owner,
            (SELECT dm.role FROM document_members dm
              WHERE dm.document_id = d.id AND dm.user_id = $2) AS member_role
     FROM documents d
     WHERE d.id = $1`,
    [documentId, userId]
  );
  if (!rows[0]) return null;
  const { is_owner: isOwner, member_role: memberRole, ...document } = rows[0];
  const isMember = Boolean(memberRole);
  const canEdit = isOwner || memberRole === 'admin';
  return { document, isOwner, isMember, memberRole, canEdit };
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

    const access = await loadAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Document not found' });
    if (!access.canEdit) {
      return res.status(403).json({
        error: 'Only the project owner or an admin can upload files',
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
        failed.push({ filename: file.originalname, error: fileErr.message });
      }
    }

    if (uploaded.length === 0) {
      // Nothing succeeded — surface the first failure's status where sensible.
      return res.status(422).json({
        error: 'No files could be ingested',
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
