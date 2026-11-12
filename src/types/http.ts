// Shapes shared across layers, plus the one helper that builds an HttpError.

/**
 * An Error carrying the HTTP status the central handler in `src/app.ts` should
 * answer with, and optionally a machine-readable code. Controllers and utils
 * attach these to a plain `Error` rather than subclassing, so the runtime
 * objects are exactly what they were before the TypeScript migration.
 */
export type HttpError = Error & { status?: number; statusCode?: number; code?: string };

/** A project member role. The owner is never a role; see `src/utils/roles.ts`. */
export type MemberRole = 'viewer' | 'editor' | 'admin';

/** The caller's resolved standing on a project token: the owner, or a live member role. */
export type TokenRole = 'owner' | MemberRole | null;

/** What `requireAuth` attaches to `req.user`. */
export interface AuthUser {
  id: string;
  username: string;
}

/** What `requireApiToken` attaches to `req.apiToken`. */
export interface ApiTokenContext {
  tokenId: string;
  userId: string;
  projectId: string;
  username: string;
  projectTitle: string;
  role: TokenRole;
}

/** A `documents` row as selected by `SELECT d.*`. */
export interface DocumentRow {
  id: string;
  owner_id: string;
  title: string;
  summary: string | null;
  embedding_model: string | null;
  created_at: Date;
  updated_at: Date;
  [column: string]: unknown;
}

/** The result of `loadAccess` in `src/utils/documentAccess.ts`. */
export interface DocumentAccess {
  document: DocumentRow;
  isOwner: boolean;
  isMember: boolean;
  memberRole: MemberRole | null;
  canEdit: boolean;
}

/**
 * Build an `HttpError` from a message and a status. The object is a plain
 * `Error` with the extra fields assigned, which is the shape the code always
 * threw; only the construction is typed.
 */
export function httpError(message: string, status: number, code?: string): HttpError {
  const err: HttpError = new Error(message);
  err.status = status;
  if (code !== undefined) err.code = code;
  return err;
}
