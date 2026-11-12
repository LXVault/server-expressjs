import express, { type Router } from 'express';
import multer from 'multer';
import type { NextFunction, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireDocumentWrite } from '../middleware/documentAccess.js';
import {
  listDocuments,
  createDocument,
  getDocument,
  updateDocument,
  listMembers,
  addMember,
  removeMember,
} from '../controllers/documentController.js';
import {
  listFiles,
  uploadFiles,
  deleteFile,
} from '../controllers/fileController.js';
import {
  getProjectToken,
  generateProjectToken,
  revokeProjectToken,
} from '../controllers/tokenController.js';
import {
  getEmbeddingModel,
  setEmbeddingModel,
  backfillEmbeddings,
  deleteModelEmbeddings,
} from '../controllers/projectModelController.js';
import { MAX_FILE_BYTES, ALLOWED_EXTENSIONS, extOf } from '../utils/fileIngest.js';

const router: Router = express.Router();

// Uploads are held in memory (small docs) and handed to the ingestion pipeline
// as buffers. We reject disallowed extensions early, before any DB work.
//
// Every limit here is a bound on what one request can make the process allocate.
// `fileSize` and `files` bound the bytes; the rest bound the shape of the
// multipart body, which is otherwise unbounded — a request could send a
// thousand small fields, or one field with a header the size of a small file,
// and neither would trip `fileSize` or `files` at all.
const MAX_FILES_PER_REQUEST = 20;
const MAX_TEXT_FIELDS = 10;
const MAX_PARTS = 30;
const MAX_FIELD_BYTES = 64 * 1024;
const MAX_HEADER_PAIRS = 2000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: MAX_FILES_PER_REQUEST,
    fields: MAX_TEXT_FIELDS,
    parts: MAX_PARTS,
    fieldSize: MAX_FIELD_BYTES,
    headerPairs: MAX_HEADER_PAIRS,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_EXTENSIONS.includes(extOf(file.originalname))) return cb(null, true);
    return cb(
      new multer.MulterError(
        'LIMIT_UNEXPECTED_FILE',
        `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
      )
    );
  },
});

// A limit that was hit is the client's payload being too big, which is 413 and
// not 400. Everything else multer raises here is a malformed request.
const LIMIT_STATUS: Readonly<Record<string, number>> = {
  LIMIT_FILE_SIZE: 413,
  LIMIT_FILE_COUNT: 413,
  LIMIT_PART_COUNT: 413,
  LIMIT_FIELD_COUNT: 413,
  LIMIT_FIELD_KEY: 413,
  LIMIT_FIELD_VALUE: 413,
  LIMIT_UNEXPECTED_FILE: 400,
  LIMIT_UNEXPECTED_PART: 400,
};

// Translate multer's own errors into clean client errors instead of 500s.
function handleUpload(req: Request, res: Response, next: NextFunction): void {
  upload.array('files', MAX_FILES_PER_REQUEST)(req, res, (err?: unknown) => {
    if (err) {
      const status =
        err instanceof multer.MulterError ? LIMIT_STATUS[err.code] || 400 : 500;
      res.status(status).json({ error: (err as Error).message });
      return;
    }
    next();
  });
}

// All document routes require authentication.
router.use(requireAuth);

router.get('/', listDocuments);
router.post('/', createDocument);
router.get('/:id', getDocument);
router.put('/:id', updateDocument);

router.get('/:id/members', listMembers);
router.post('/:id/members', addMember);
router.delete('/:id/members/:userId', removeMember);

// Knowledge-base files (the project's "central index"). Listing is open to any
// member.
//
// The upload route authorizes BEFORE multer runs. Order is load-bearing here:
// multer buffers into memory, so authorizing after it means an unauthorized
// caller has already made the process hold the whole upload. The controller
// still re-checks via `req.documentAccess` rather than trusting the middleware,
// because it is the thing that decides what a file may do.
router.get('/:id/files', listFiles);
router.post('/:id/files', requireDocumentWrite, handleUpload, uploadFiles);
router.delete('/:id/files/:fileId', deleteFile);

// Per-project execution token (one per user per project).
router.get('/:id/token', getProjectToken);
router.post('/:id/token', generateProjectToken);
router.delete('/:id/token', revokeProjectToken);

// Per-project embedding model (read for members; change for owner/admin).
// Changing the model never deletes a vector, so the read reports coverage and
// the two routes below are the only ways to add or remove one.
router.get('/:id/embedding-model', getEmbeddingModel);
router.put('/:id/embedding-model', setEmbeddingModel);

// Embed the chunks missing a vector for the current model, and reclaim the
// space held by a model the project no longer uses. Owner/admin only, enforced
// in the controller. The model segment is a provider-namespaced id, so it
// contains a slash and needs the wildcard to survive routing.
//
// The wildcard form is `*name`. Express 5 uses path-to-regexp v8, which removed
// the custom-parameter regex `(*)` that Express 4 accepted. The controller
// rejects an empty match before it reaches SQL, so a wildcard that also matches
// no segments at all is safe here.
router.post('/:id/embeddings/backfill', backfillEmbeddings);
router.delete('/:id/embeddings/*model', deleteModelEmbeddings);

export default router;
