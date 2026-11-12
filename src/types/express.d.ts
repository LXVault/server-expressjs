// Request properties this application attaches in its own middleware.
//
//   req.user            set by requireAuth (src/middleware/auth.ts), JWT routes
//   req.apiToken        set by requireApiToken (src/middleware/apiToken.ts), /api/mcp
//   req.documentAccess  set by requireDocumentWrite (src/middleware/documentAccess.ts)
//
// Each is optional on the type because each is only present behind its guard.
// A controller that runs behind the guard reads it with a non-null assertion,
// which records the dependency on route wiring at the point it is relied on.
import type { ApiTokenContext, AuthUser, DocumentAccess } from './http.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      apiToken?: ApiTokenContext;
      documentAccess?: DocumentAccess;
    }
  }
}

export {};
