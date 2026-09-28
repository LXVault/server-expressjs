'use strict';

const db = require('../config/db');
const { isUuid, loadAccess } = require('../utils/documentAccess');
// The role list and both authority questions come from roles.js. This file used
// to carry its own copy of the list and answered "is this the owner" inline,
// which is the duplication that file exists to remove.
const { canAdminister, isMemberRole, MEMBER_ROLES } = require('../utils/roles');

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
              COUNT(dc.id)::int AS chunk_count,
              (SELECT COUNT(*)::int FROM document_files df
                WHERE df.document_id = d.id) AS file_count
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
    return res.json({
      document: access.document,
      isOwner: access.isOwner,
      role: access.isOwner ? 'owner' : access.memberRole,
      canEdit: access.canEdit,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * PUT /api/documents/:id (protected, owner/admin only)
 * Body: { title, summary }
 * Updates a project's title and/or description.
 */
async function updateDocument(req, res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid document id' });

    const access = await loadAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Document not found' });
    if (!access.canEdit) {
      return res.status(403).json({
        error: 'Only the project owner or an admin can edit this project',
      });
    }

    const { title, summary } = req.body || {};
    if (title === undefined && summary === undefined) {
      return res.status(400).json({ error: 'Provide title and/or summary to update' });
    }
    if (title !== undefined && !String(title).trim()) {
      return res.status(400).json({ error: 'title cannot be empty' });
    }

    // Only overwrite the fields that were supplied.
    const nextTitle = title !== undefined ? String(title).trim() : access.document.title;
    const nextSummary =
      summary !== undefined
        ? (String(summary).trim() || null)
        : access.document.summary;

    const { rows } = await db.query(
      `UPDATE documents
       SET title = $2, summary = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, title, summary, owner_id, embedding_model, created_at, updated_at`,
      [id, nextTitle, nextSummary]
    );

    return res.json({ document: rows[0] });
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
      canManage: canAdminister(access.isOwner, access.memberRole),
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/documents/:id/members (protected, owner or admin)
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
    if (!isMemberRole(role)) {
      return res.status(400).json({ error: `role must be one of: ${MEMBER_ROLES.join(', ')}` });
    }

    const access = await loadAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Document not found' });
    if (!canAdminister(access.isOwner, access.memberRole)) {
      return res.status(403).json({ error: 'Only the project owner or an admin can add members' });
    }

    const target = String(identifier).trim();
    const userResult = await db.query(
      `SELECT id, username, email FROM users WHERE username = $1 OR email = $1`,
      [target]
    );
    const user = userResult.rows[0];
    if (!user) {
      // The message is fixed and does not echo the identifier back. This
      // endpoint is the one place an authenticated user could otherwise read
      // the user table one probe at a time, and a response that repeats the
      // probe confirms the lookup ran.
      return res.status(404).json({ error: 'No user matches that username or email' });
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
 * DELETE /api/documents/:id/members/:userId (protected, owner or admin)
 */
async function removeMember(req, res, next) {
  try {
    const { id, userId } = req.params;
    if (!isUuid(id) || !isUuid(userId)) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const access = await loadAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Document not found' });
    if (!canAdminister(access.isOwner, access.memberRole)) {
      return res.status(403).json({ error: 'Only the project owner or an admin can remove members' });
    }

    const { rowCount } = await db.query(
      `DELETE FROM document_members WHERE document_id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Member not found on this document' });
    }

    // Revoke this member's project tokens explicitly, in the same request that
    // removed them. The requireApiToken guard already stops the token working
    // the moment the membership row is gone, so this is not what enforces the
    // removal — it is what stops the token coming back. Without it, a member
    // removed and later re-added would find their old token working again,
    // including any authority it had been issued under.
    await db.query(
      `UPDATE api_tokens
          SET is_active = FALSE
        WHERE project_id = $1
          AND user_id = $2
          AND is_active = TRUE`,
      [id, userId]
    );

    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listDocuments,
  createDocument,
  getDocument,
  updateDocument,
  listMembers,
  addMember,
  removeMember,
};
