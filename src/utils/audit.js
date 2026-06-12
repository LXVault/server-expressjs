'use strict';

const db = require('../config/db');

/**
 * Append an entry to `audit_logs`. This is how we trace *who* executed an
 * action — every token-authenticated request records the acting user and the
 * token that was used.
 *
 * Auditing must never break the request it describes, so failures are logged
 * and swallowed rather than thrown.
 *
 * @param {Object} entry
 * @param {string} [entry.userId]        Acting user id.
 * @param {string} [entry.tokenId]       Token used to perform the action.
 * @param {string} entry.actionType      Short verb, e.g. 'mcp.search'.
 * @param {string} [entry.resourceTable] Table the action targeted.
 * @param {string} [entry.resourceId]    Row the action targeted.
 * @param {Object} [entry.details]       Arbitrary JSON context.
 */
async function recordAudit({
  userId,
  tokenId,
  actionType,
  resourceTable,
  resourceId,
  details,
} = {}) {
  try {
    await db.query(
      `INSERT INTO audit_logs
         (user_id, token_id, action_type, resource_table, resource_id, action_details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId || null,
        tokenId || null,
        actionType,
        resourceTable || null,
        resourceId || null,
        details ? JSON.stringify(details) : null,
      ]
    );
  } catch (err) {
    console.error('[audit] failed to record entry:', err.message);
  }
}

module.exports = { recordAudit };
