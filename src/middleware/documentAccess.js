'use strict';

const { isUuid, loadAccess } = require('../utils/documentAccess');

/**
 * Authorize a write to a project BEFORE the request body is read.
 *
 * This exists because of an ordering problem, not a logic one. `multer` holds
 * uploads in memory, and it can only do that once the request stream has been
 * consumed — so if authorization runs after it, an unauthorized caller has
 * already made the server allocate up to 20 files of 10 MB each. Moving the
 * check in front of the parser means a caller with no access is refused at 403
 * having cost the process nothing.
 *
 * The access is resolved once here and attached to the request, so the
 * controller that follows does not repeat the query.
 *
 * Populates `req.documentAccess`, the same shape `loadAccess` returns.
 */
async function requireDocumentWrite(req, res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) {
      return res.status(400).json({ error: 'Invalid document id' });
    }

    const access = await loadAccess(id, req.user.id);
    if (!access) return res.status(404).json({ error: 'Document not found' });

    // A non-member gets 403 before the role question is asked, so the response
    // does not distinguish "no such project" from "not yours" any differently
    // than the other read paths already do.
    if (!access.isOwner && !access.isMember) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }
    if (!access.canEdit) {
      return res.status(403).json({
        error: 'Only the project owner, or an editor or admin, can do this',
      });
    }

    req.documentAccess = access;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireDocumentWrite };
