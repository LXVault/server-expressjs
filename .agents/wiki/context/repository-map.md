---
name: agent-wiki-context-repository-map
description: Orientation for an agent before touching this backend. What lives where, how to run and verify it, entry points, and the gotchas that cost time.
---

# Repository Map

Read this before editing anything in `mcp-rag-server`. Underlying facts live once in
`wiki/` and are linked rather than repeated.

## What this is

An Express.js JSON API over PostgreSQL with pgvector. It backs two clients: the React web
app in `LXVault/client-reactjs` and the MCP server in `LXVault/mcp`. Both talk to the same
routes under `/api`. Concepts and vocabulary:
[`../../../wiki/information/overview.md`](../../../wiki/information/overview.md).

## Layout

| Path | Holds |
|---|---|
| `src/index.js` | Boot. Starts the listener, runs a database health check, applies the schema, wires graceful shutdown. |
| `src/app.js` | The Express app: CORS policy, JSON body limit, `/health`, the `/api` mount, the 404 and error handlers. |
| `src/config/db.js` | The `pg` pool and `healthCheck`. Anything needing a transaction takes a client from `pool`. |
| `src/config/env.js` | Every environment variable, each with a fallback so the app boots without a `.env` in development. In production the fallback secrets are refused and the process exits. |
| `src/config/migrate.js` | Reads `db/init.sql` and applies it on boot unless `AUTO_MIGRATE=false`. |
| `src/routes/` | Path to controller wiring, one file per feature, aggregated by `routes/index.js`. |
| `src/controllers/` | Validation, authorization and SQL. |
| `src/utils/` | Logic shared by more than one controller: embeddings, file ingestion, crypto, JWT, audit, user keys, API tokens, roles, document access. |
| `src/middleware/` | `auth.js` for JWT, `apiToken.js` for per project tokens, `documentAccess.js` for project authorization ahead of the upload parser. |
| `db/init.sql` | The one and only schema definition. Idempotent by construction. |

## Entry points

* Process start: `src/index.js`.
* HTTP surface: `src/app.js`, then `src/routes/index.js` for everything under `/api`.
* Schema: `db/init.sql`. Nothing else defines a table.

## Running and verifying

```
npm install
npm run dev          # nodemon on PORT, default 4000
curl localhost:4000/health
```

The server needs a PostgreSQL database with the `vector` extension available. Full setup,
including the connection string and the Docker path:
[`../../../wiki/environments/setup.md`](../../../wiki/environments/setup.md).

**There is no test suite and no linter.** Verification is manual: boot the server and
exercise the route you changed. Report it that way; do not imply a suite ran.

## Gotchas

* **The schema runs on every boot.** Any statement you add to `db/init.sql` executes
  against databases that already hold rows, every time the process starts. If it is not
  idempotent it is a bug that only shows up in production.
* **`documents` is the projects table.** A project, a document and a knowledge base are one
  row. The API, the client and the tokens all key off it.
* **Two auth paths.** `req.user` comes from a JWT, `req.apiToken` from a per project token.
  MCP controllers must resolve identity and project from `req.apiToken` alone; see
  [`../../rules/repository.md`](../../rules/repository.md) for why that is a security
  invariant rather than a style preference.
* **Role checks go through `src/utils/roles.js`.** `canWrite` and `canAdminister` are the
  only two questions, and they take ownership as a separate flag because the owner is
  `documents.owner_id`, not a role. Writing an inline `isOwner || role === 'admin'` puts
  you back at the bug that file exists to prevent. Administration is stricter than writing
  on purpose: an editor that could grant roles could promote itself.
* **A project token is re-checked against live membership on every request.** The query in
  `src/middleware/apiToken.js` joins `document_members` and refuses a token whose user no
  longer owns or belongs to the project. Removing that join silently turns removal back
  into something that needs a separate revoke, and the role it exposes comes from the same
  row, so a demotion takes effect on the next call too.
* **No server owned OpenRouter key.** Embedding calls spend the acting user's key. Code
  paths that assume a key is always present are wrong; a missing key is a `412`.
* **The `embedding` column has no dimension and no ANN index.** That is deliberate, so
  projects can pick models of different sizes and hold rows for two of them at once. Do not
  add an index without fixing the dimension first.
* **A chunk's text and its vector are different rows.** `document_chunks` is content;
  `document_chunk_embeddings` is one vector per `(chunk_id, model_name)`. Writing a chunk
  means writing both, in one transaction.
* **A chunk count is not a searchable count.** Search only sees chunks with a vector for
  the project's current model, so report coverage from
  `src/utils/embeddingCoverage.js` rather than counting chunks and implying they are all
  reachable.
* **The whole schema is sent through the simple query protocol** in one `pool.query(sql)`,
  so `db/init.sql` must contain no bind parameters.
* **Middleware order on the upload route is load-bearing.** `requireDocumentWrite` must
  stay ahead of `handleUpload` on `POST /api/documents/:id/files`. `multer` buffers into
  memory, so authorizing after it means the caller has already made the process hold the
  whole upload. This is easy to "tidy up" and silently reintroduces a 200 MB allocation by
  an unauthorized caller.
* **There is one access query, in `src/utils/documentAccess.js`.** It used to be copied
  into both document and file controllers. The upload middleware needs it too, so a third
  copy is the failure mode; add a controller to the existing helper instead.
* **An upload is bounded by chunk count, not just byte size.** `MAX_FILE_BYTES` caps the
  input but not the work: 10 MB of dense text is roughly 11,000 chunks and one embedding
  call each. `MAX_CHUNKS_PER_FILE` in `fileIngest.js` is the check that matters, and it
  must stay *before* the embedding loop — that ordering is the whole point.
* **`TRUST_PROXY` is a number, never `true`.** It decides whether `X-Forwarded-For` is
  believed, and anything limiting requests per IP rests on `req.ip` being the client.
  `true` trusts the last hop, which is the caller. Unset is the safe default; a positive
  integer is the count of proxies in front of the app.
* **A multer limit is a `413`, not a `400`.** `LIMIT_STATUS` in `src/routes/documents.js`
  maps each `LIMIT_*` code to the status it deserves. Adding a limit without a row there
  silently degrades it to 400.

## Where things get documented

Human documentation goes in `wiki/`, agent knowledge in `.agents/wiki/`, memory in
`.agents/memory/`, and indexes in `.agents/index/`. The placement rules are in
[`../../../AGENTS.md`](../../../AGENTS.md); the shared set is resolved through the
`lxagents-agents-base` connector and is never copied into this repository.
