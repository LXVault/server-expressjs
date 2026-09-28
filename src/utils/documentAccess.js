'use strict';

const db = require('../config/db');
const { canWrite } = require('./roles');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Resolve a document and the caller's relationship to it.
 *
 * One query, one definition. This lived twice — once in `documentController` and
 * once in `fileController`, differing only in which columns they selected — and
 * the upload authorization middleware needs it too. Three copies of an
 * authorization query is three chances to disagree about who may do what.
 *
 * @param {string} documentId
 * @param {string} userId
 * @returns {Promise<{document: Object, isOwner: boolean, isMember: boolean,
 *   memberRole: string|null, canEdit: boolean}|null>} null when no such document.
 */
async function loadAccess(documentId, userId) {
  const { rows } = await db.query(
    `SELECT d.*,
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
  const canEdit = canWrite(isOwner, memberRole);
  return { document, isOwner, isMember, memberRole, canEdit };
}

module.exports = { isUuid, loadAccess };
