'use strict';

const db = require('../config/db');
const { recordAudit } = require('../utils/audit');
const { embedText, toVectorLiteral } = require('../utils/embeddings');
const { getDecryptedOpenRouterKey } = require('../utils/userKeys');
const { ingestFile, ALLOWED_EXTENSIONS, isAllowedFilename } = require('../utils/fileIngest');

const NO_KEY_MESSAGE =
  'No OpenRouter API key configured for your account. Add your own key in the ' +
  'web app (Profile → OpenRouter API key) before using semantic search.';

/**
 * Fetch a project's currently selected embedding model.
 * @returns {Promise<string|null>}
 */
async function getProjectModel(projectId) {
  const { rows } = await db.query(
    `SELECT embedding_model FROM documents WHERE id = $1`,
    [projectId]
  );
  return rows[0] ? rows[0].embedding_model : null;
}

/**
 * GET /api/mcp/me  (API-token auth)
 * Identifies the user and project the presented token is bound to.
 */
async function me(req, res, next) {
  try {
    const { tokenId, userId, username, projectId, projectTitle } = req.apiToken;

    await recordAudit({
      userId,
      tokenId,
      actionType: 'mcp.whoami',
      resourceTable: 'documents',
      resourceId: projectId,
    });

    return res.json({
      user: { id: userId, username },
      project: { id: projectId, title: projectTitle },
      tokenId,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/mcp/project  (API-token auth)
 * Returns details about the project the token grants access to, including its
 * selected embedding model and a chunk count.
 */
async function getProject(req, res, next) {
  try {
    const { tokenId, userId, projectId } = req.apiToken;

    const { rows } = await db.query(
      `SELECT d.id,
              d.title,
              d.summary,
              d.embedding_model,
              d.created_at,
              d.updated_at,
              COUNT(dc.id)::int AS chunk_count
       FROM documents d
       LEFT JOIN document_chunks dc ON dc.document_id = d.id
       WHERE d.id = $1
       GROUP BY d.id`,
      [projectId]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Project not found' });

    await recordAudit({
      userId,
      tokenId,
      actionType: 'mcp.get_project',
      resourceTable: 'documents',
      resourceId: projectId,
    });

    return res.json({ project: rows[0] });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/mcp/search  (API-token auth)
 * Body: { query, limit? }
 * Semantic search: embeds the query with the project's model (using the acting
 * user's own OpenRouter key) and ranks chunks by cosine similarity. Audited.
 */
async function search(req, res, next) {
  try {
    const { tokenId, userId, projectId } = req.apiToken;
    const { query, limit } = req.body || {};

    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    const max = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 25);
    const term = String(query).trim();

    const apiKey = await getDecryptedOpenRouterKey(userId);
    if (!apiKey) return res.status(412).json({ error: NO_KEY_MESSAGE });

    const model = await getProjectModel(projectId);
    const queryVector = await embedText({ apiKey, model, input: term });

    // Exact KNN by cosine distance; only compare chunks embedded with the
    // project's current model so dimensions always match.
    const { rows } = await db.query(
      `SELECT id, chunk_index, content,
              1 - (embedding <=> $2::vector) AS score
       FROM document_chunks
       WHERE document_id = $1
         AND embedding IS NOT NULL
         AND embedding_model = $3
       ORDER BY embedding <=> $2::vector
       LIMIT $4`,
      [projectId, toVectorLiteral(queryVector), model, max]
    );

    await recordAudit({
      userId,
      tokenId,
      actionType: 'mcp.search',
      resourceTable: 'documents',
      resourceId: projectId,
      details: { query: term, model, results: rows.length },
    });

    return res.json({ query: term, model, results: rows, total: rows.length });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/mcp/knowledge  (API-token auth)
 * Body: { content }
 * Embeds the text with the project's model (using the acting user's OpenRouter
 * key) and stores it as a new chunk. Audited against the acting user + token.
 */
async function addKnowledge(req, res, next) {
  try {
    const { tokenId, userId, projectId } = req.apiToken;
    const { content } = req.body || {};

    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: 'content is required' });
    }
    const text = String(content).trim();

    const apiKey = await getDecryptedOpenRouterKey(userId);
    if (!apiKey) return res.status(412).json({ error: NO_KEY_MESSAGE });

    const model = await getProjectModel(projectId);
    const vector = await embedText({ apiKey, model, input: text });

    const { rows } = await db.query(
      `INSERT INTO document_chunks (document_id, content, chunk_index, embedding, embedding_model)
       VALUES (
         $1,
         $2,
         COALESCE(
           (SELECT MAX(chunk_index) + 1 FROM document_chunks WHERE document_id = $1),
           0
         ),
         $3::vector,
         $4
       )
       RETURNING id, chunk_index, content, embedding_model, created_at`,
      [projectId, text, toVectorLiteral(vector), model]
    );

    const chunk = rows[0];

    await recordAudit({
      userId,
      tokenId,
      actionType: 'mcp.add_knowledge',
      resourceTable: 'document_chunks',
      resourceId: chunk.id,
      details: { chunk_index: chunk.chunk_index, model, length: text.length },
    });

    return res.status(201).json({ chunk });
  } catch (err) {
    return next(err);
  }
}

// Roles a member may be granted.
const ALLOWED_MEMBER_ROLES = ['editor', 'viewer', 'admin'];

/**
 * Authorisation guard for project-mutating MCP tools.
 *
 * SECURITY: the caller's role is resolved ENTIRELY from server-side data — the
 * user + project bound to the presented API token — never from tool arguments.
 * This means a prompt-injected tool call cannot escalate privileges or target
 * a different project: the LLM has no way to assert "I am an admin" or to point
 * the mutation at someone else's project. Throws 403 if the token's user is not
 * the owner or an admin of the token's project.
 *
 * @returns {Promise<{isOwner: boolean, role: string|null, ownerId: string}>}
 */
async function assertProjectAdmin(projectId, userId) {
  const { rows } = await db.query(
    `SELECT d.owner_id,
            (d.owner_id = $2) AS is_owner,
            (SELECT dm.role FROM document_members dm
              WHERE dm.document_id = d.id AND dm.user_id = $2) AS member_role
     FROM documents d
     WHERE d.id = $1`,
    [projectId, userId]
  );
  if (!rows[0]) {
    const err = new Error('Project not found');
    err.status = 404;
    throw err;
  }
  const isOwner = rows[0].is_owner;
  const role = rows[0].member_role;
  if (!(isOwner || role === 'admin')) {
    const err = new Error('Forbidden: you must be the project owner or an admin');
    err.status = 403;
    throw err;
  }
  return { isOwner, role, ownerId: rows[0].owner_id };
}

/**
 * POST /api/mcp/projects  (API-token auth)
 * Body: { title, summary? }
 * Creates a NEW project owned by the token's user. The owner is taken from the
 * token (req.apiToken.userId), so it cannot be spoofed via tool arguments.
 */
async function createProject(req, res, next) {
  try {
    const { userId, tokenId } = req.apiToken;
    const { title, summary } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title is required' });
    }

    const { rows } = await db.query(
      `INSERT INTO documents (owner_id, title, summary)
       VALUES ($1, $2, $3)
       RETURNING id, title, summary, owner_id, embedding_model, created_at, updated_at`,
      [userId, String(title).trim(), summary ? String(summary).trim() : null]
    );
    const project = rows[0];

    await recordAudit({
      userId,
      tokenId,
      actionType: 'mcp.create_project',
      resourceTable: 'documents',
      resourceId: project.id,
      details: { title: project.title },
    });

    return res.status(201).json({ project });
  } catch (err) {
    return next(err);
  }
}

/**
 * PUT /api/mcp/project/title  (API-token auth, owner/admin only)
 * Body: { title }
 * Renames the token's bound project. Target project = req.apiToken.projectId
 * (never taken from arguments).
 */
async function updateProjectTitle(req, res, next) {
  try {
    const { userId, tokenId, projectId } = req.apiToken;
    const { title } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title is required' });
    }

    await assertProjectAdmin(projectId, userId);

    const { rows } = await db.query(
      `UPDATE documents SET title = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, title, summary, updated_at`,
      [projectId, String(title).trim()]
    );

    await recordAudit({
      userId,
      tokenId,
      actionType: 'mcp.change_project_title',
      resourceTable: 'documents',
      resourceId: projectId,
      details: { title: rows[0].title },
    });

    return res.json({ project: rows[0] });
  } catch (err) {
    return next(err);
  }
}

/**
 * PUT /api/mcp/project/description  (API-token auth, owner/admin only)
 * Body: { description }
 * Updates the token's bound project description (stored as summary).
 */
async function updateProjectDescription(req, res, next) {
  try {
    const { userId, tokenId, projectId } = req.apiToken;
    const { description } = req.body || {};
    if (description === undefined || description === null) {
      return res.status(400).json({ error: 'description is required' });
    }

    await assertProjectAdmin(projectId, userId);

    const summary = String(description).trim() || null;
    const { rows } = await db.query(
      `UPDATE documents SET summary = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, title, summary, updated_at`,
      [projectId, summary]
    );

    await recordAudit({
      userId,
      tokenId,
      actionType: 'mcp.change_project_description',
      resourceTable: 'documents',
      resourceId: projectId,
      details: { length: summary ? summary.length : 0 },
    });

    return res.json({ project: rows[0] });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/mcp/project/members  (API-token auth, owner/admin only)
 * Body: { identifier (username or email), role? }
 * Adds (or updates the role of) a member on the token's bound project.
 */
async function addProjectMember(req, res, next) {
  try {
    const { userId, tokenId, projectId } = req.apiToken;
    const { identifier, role = 'editor' } = req.body || {};
    if (!identifier || !String(identifier).trim()) {
      return res.status(400).json({ error: 'identifier (username or email) is required' });
    }
    if (!ALLOWED_MEMBER_ROLES.includes(role)) {
      return res
        .status(400)
        .json({ error: `role must be one of: ${ALLOWED_MEMBER_ROLES.join(', ')}` });
    }

    const { ownerId } = await assertProjectAdmin(projectId, userId);

    const target = String(identifier).trim();
    const userResult = await db.query(
      `SELECT id, username, email FROM users WHERE username = $1 OR email = $1`,
      [target]
    );
    const user = userResult.rows[0];
    if (!user) {
      return res.status(404).json({ error: `No user found matching "${target}"` });
    }
    if (user.id === ownerId) {
      return res.status(409).json({ error: 'That user already owns this project' });
    }

    const { rows } = await db.query(
      `INSERT INTO document_members (document_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (document_id, user_id)
       DO UPDATE SET role = EXCLUDED.role
       RETURNING user_id, role, added_at`,
      [projectId, user.id, role]
    );

    const member = { ...rows[0], username: user.username, email: user.email };

    await recordAudit({
      userId,
      tokenId,
      actionType: 'mcp.add_member',
      resourceTable: 'document_members',
      resourceId: projectId,
      details: { addedUserId: user.id, role },
    });

    return res.status(201).json({ member });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/mcp/files  (API-token auth, owner/admin only)
 * Body: { filename, content? , contentBase64? }
 * Uploads a knowledge file to the token's bound project. Text files (.md/.txt)
 * may be sent as `content`; binary files (.pdf) must be sent as base64 in
 * `contentBase64`. The file is chunked, embedded with the project's model using
 * the acting user's OpenRouter key, and stored. Owner/admin enforced from the
 * token — never from arguments.
 */
async function uploadFile(req, res, next) {
  try {
    const { userId, tokenId, projectId } = req.apiToken;
    const { filename, content, contentBase64 } = req.body || {};

    if (!filename || !String(filename).trim()) {
      return res.status(400).json({ error: 'filename is required' });
    }
    const name = String(filename).trim();
    if (!isAllowedFilename(name)) {
      return res
        .status(400)
        .json({ error: `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}` });
    }
    if (!content && !contentBase64) {
      return res
        .status(400)
        .json({ error: 'Provide file contents as "content" (text) or "contentBase64"' });
    }

    // Decode to a buffer. Base64 wins when both are present.
    let buffer;
    if (contentBase64) {
      try {
        buffer = Buffer.from(String(contentBase64), 'base64');
      } catch {
        return res.status(400).json({ error: 'contentBase64 is not valid base64' });
      }
    } else {
      buffer = Buffer.from(String(content), 'utf8');
    }

    await assertProjectAdmin(projectId, userId);

    const apiKey = await getDecryptedOpenRouterKey(userId);
    if (!apiKey) return res.status(412).json({ error: NO_KEY_MESSAGE });

    const model = await getProjectModel(projectId);
    const file = await ingestFile({
      projectId,
      userId,
      apiKey,
      model,
      filename: name,
      buffer,
    });

    await recordAudit({
      userId,
      tokenId,
      actionType: 'mcp.upload_file',
      resourceTable: 'document_files',
      resourceId: file.id,
      details: { filename: file.filename, chunks: file.chunk_count, model },
    });

    return res.status(201).json({ file });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  me,
  getProject,
  search,
  addKnowledge,
  createProject,
  updateProjectTitle,
  updateProjectDescription,
  addProjectMember,
  uploadFile,
};
