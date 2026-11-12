import * as db from '../config/db.js';

/** One `audit_logs` entry. Every field but `actionType` is optional. */
export interface AuditEntry {
  /** Acting user id. */
  userId?: string | null;
  /** Token used to perform the action. */
  tokenId?: string | null;
  /** Short verb, e.g. 'mcp.search'. */
  actionType: string;
  /** Table the action targeted. */
  resourceTable?: string | null;
  /** Row the action targeted. */
  resourceId?: string | null;
  /** Arbitrary JSON context. */
  details?: Record<string, unknown> | null;
}

/**
 * Append an entry to `audit_logs`. This is how we trace *who* executed an
 * action — every token-authenticated request records the acting user and the
 * token that was used.
 *
 * Auditing must never break the request it describes, so failures are logged
 * and swallowed rather than thrown.
 */
export async function recordAudit({
  userId,
  tokenId,
  actionType,
  resourceTable,
  resourceId,
  details,
}: AuditEntry): Promise<void> {
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
    console.error('[audit] failed to record entry:', (err as Error).message);
  }
}
