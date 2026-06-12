'use strict';

const db = require('../config/db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ROLES = ['editor', 'viewer', 'admin'];

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Fetch a document and the caller's relationship to it.
 * Returns { document, isOwner, isMember } or null when not found.
 */
async function loadAccess(documentId, userId) {
  const { rows } = await db.query(
    `SELECT d.*,
            (d.owner_id = $2) AS is_owner,
            EXISTS (
              SELECT 1 FROM document_members dm
              WHERE dm.document_id = d.id AND dm.user_id = $2
            ) AS is_member
     FROM documents d
     WHERE d.id = $1`,
    [documentId, userId]
  );
  if (!rows[0]) return null;
  const { is_owner: isOwner, is_member: isMember, ...document } = rows[0];
  return { document, isOwner, isMember };
}

/**
 * GET /api/documents (protected)
 * Lists documents the user owns or is a member of, with chunk counts.
 */
async function listDocuments(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT d.id,
              d.title,
              d.summary,
              d.owner_id,
              (d.owner_id = $1) AS is_owner,
              COALESCE(dm.role, 'owner') AS role,
              d.created_at,
              d.updated_at,
              COUNT(dc.id)::int AS chunk_count
       FROM documents d
       LEFT JOIN document_members dm
              ON dm.document_id = d.id AND dm.user_id = $1
       LEFT JOIN document_chunks dc
              ON dc.document_id = d.id
       WHERE d.owner_id = $1 OR dm.user_id = $1
       GROUP BY d.id, dm.role
       ORDER BY d.updated_at DESC`,
      [req.user.id]
    );

    return res.json({ documents: rows, total: rows.length });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/documents (protected)
 * Creates a new document/project owned by the caller.
 */
async function createDocument(req, res, next) {
  try {
    const { title, summary } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title is required' });
    }

    const { rows } = await db.query(
      `INSERT INTO documents (owner_id, title, summary)
       VALUES ($1, $2, $3)
       RETURNING id, title, summary, owner_id, created_at, updated_at`,
      [req.user.id, String(title).trim(), summary ? String(summary).trim() : null]
    );

    const document = { ...rows[0], is_owner: true, role: 'owner', chunk_count: 0 };
    return res.status(201).json({ document });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/documents/:id (protected)
 */
async function getDocument(req, res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid document id' });

    const access = await loadAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Document not found' });
    if (!access.isOwner && !access.isMember) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }
    return res.json({ document: access.document, isOwner: access.isOwner });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/documents/:id/members (protected)
 * Lists the owner plus all shared members of the document.
 */
async function listMembers(req, res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid document id' });

    const access = await loadAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Document not found' });
    if (!access.isOwner && !access.isMember) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    const ownerResult = await db.query(
      `SELECT id AS user_id, username, email FROM users WHERE id = $1`,
      [access.document.owner_id]
    );

    const membersResult = await db.query(
      `SELECT u.id AS user_id, u.username, u.email, dm.role, dm.added_at
       FROM document_members dm
       JOIN users u ON u.id = dm.user_id
       WHERE dm.document_id = $1
       ORDER BY dm.added_at ASC`,
      [id]
    );

    const owner = ownerResult.rows[0]
      ? { ...ownerResult.rows[0], role: 'owner', added_at: access.document.created_at }
      : null;

    return res.json({
      document: { id: access.document.id, title: access.document.title },
      owner,
      members: membersResult.rows,
      canManage: access.isOwner,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/documents/:id/members (protected, owner only)
 * Body: { identifier (username or email), role }
 */
async function addMember(req, res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid document id' });

    const { identifier, role = 'editor' } = req.body || {};
    if (!identifier || !String(identifier).trim()) {
      return res.status(400).json({ error: 'identifier (username or email) is required' });
    }
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ALLOWED_ROLES.join(', ')}` });
    }

    const access = await loadAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Document not found' });
    if (!access.isOwner) {
      return res.status(403).json({ error: 'Only the document owner can add members' });
    }

    const target = String(identifier).trim();
    const userResult = await db.query(
      `SELECT id, username, email FROM users WHERE username = $1 OR email = $1`,
      [target]
    );
    const user = userResult.rows[0];
    if (!user) {
      return res.status(404).json({ error: `No user found matching "${target}"` });
    }
    if (user.id === access.document.owner_id) {
      return res.status(409).json({ error: 'That user already owns this document' });
    }

    const { rows } = await db.query(
      `INSERT INTO document_members (document_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (document_id, user_id)
       DO UPDATE SET role = EXCLUDED.role
       RETURNING user_id, role, added_at`,
      [id, user.id, role]
    );

    const member = { ...rows[0], username: user.username, email: user.email };
    return res.status(201).json({ member });
  } catch (err) {
    return next(err);
  }
}

/**
 * DELETE /api/documents/:id/members/:userId (protected, owner only)
 */
async function removeMember(req, res, next) {
  try {
    const { id, userId } = req.params;
    if (!isUuid(id) || !isUuid(userId)) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const access = await loadAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Document not found' });
    if (!access.isOwner) {
      return res.status(403).json({ error: 'Only the document owner can remove members' });
    }

    const { rowCount } = await db.query(
      `DELETE FROM document_members WHERE document_id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Member not found on this document' });
    }
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listDocuments,
  createDocument,
  getDocument,
  listMembers,
  addMember,
  removeMember,
};
