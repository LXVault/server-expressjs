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
| `src/config/env.js` | Every environment variable, each with a fallback so the app boots without a `.env`. |
| `src/config/migrate.js` | Reads `db/init.sql` and applies it on boot unless `AUTO_MIGRATE=false`. |
| `src/routes/` | Path to controller wiring, one file per feature, aggregated by `routes/index.js`. |
| `src/controllers/` | Validation, authorization and SQL. |
| `src/utils/` | Logic shared by more than one controller: embeddings, file ingestion, crypto, JWT, audit, user keys, API tokens. |
| `src/middleware/` | `auth.js` for JWT, `apiToken.js` for per project tokens. |
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

## Where things get documented

Human documentation goes in `wiki/`, agent knowledge in `.agents/wiki/`, memory in
`.agents/memory/`, and indexes in `.agents/index/`. The placement rules are in
[`../../../AGENTS.md`](../../../AGENTS.md); the shared set is resolved through the
`lxagents-agents-base` connector and is never copied into this repository.
