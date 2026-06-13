'use strict';

const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const {
  listDocuments,
  createDocument,
  getDocument,
  updateDocument,
  listMembers,
  addMember,
  removeMember,
} = require('../controllers/documentController');
const {
  listFiles,
  uploadFiles,
  deleteFile,
} = require('../controllers/fileController');
const {
  getProjectToken,
  generateProjectToken,
  revokeProjectToken,
} = require('../controllers/tokenController');
const {
  getEmbeddingModel,
  setEmbeddingModel,
} = require('../controllers/projectModelController');
const { MAX_FILE_BYTES, ALLOWED_EXTENSIONS, extOf } = require('../utils/fileIngest');

const router = express.Router();

// Uploads are held in memory (small docs) and handed to the ingestion pipeline
// as buffers. We reject disallowed extensions early, before any DB work.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 20 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_EXTENSIONS.includes(extOf(file.originalname))) return cb(null, true);
    return cb(
      new multer.MulterError(
        'LIMIT_UNEXPECTED_FILE',
        `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
      )
    );
  },
});

// Translate multer's own errors into clean 400s instead of 500s.
function handleUpload(req, res, next) {
  upload.array('files', 20)(req, res, (err) => {
    if (err) {
      const status = err instanceof multer.MulterError ? 400 : 500;
      return res.status(status).json({ error: err.message });
    }
    return next();
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
// member; upload/delete are restricted to owner/admin inside the controller.
router.get('/:id/files', listFiles);
router.post('/:id/files', handleUpload, uploadFiles);
router.delete('/:id/files/:fileId', deleteFile);

// Per-project execution token (one per user per project).
router.get('/:id/token', getProjectToken);
router.post('/:id/token', generateProjectToken);
router.delete('/:id/token', revokeProjectToken);

// Per-project embedding model (read for members; change for owner/admin).
router.get('/:id/embedding-model', getEmbeddingModel);
router.put('/:id/embedding-model', setEmbeddingModel);

module.exports = router;
