---
name: repository-rules
description: Rules specific to the mcp-rag-server backend: the single schema file, layer boundaries, the two auth paths, and the embedding invariants.
---

# Repository Rules

Rules that are true for this backend and nowhere else. Conventions true for more than this
repository live in the shared set and are never restated here.

## Mode and shared set

This repository is a **Mode B consumer**. The shared instruction set is resolved through
the `lxagents-agents-base` MCP connector, as declared in the bootstrap block of
[`../../AGENTS.md`](../../AGENTS.md). Nothing from that set is copied into this repository.

## The schema is one idempotent file

`db/init.sql` is the only schema definition. There is no migrations folder, no migration
tool, and no numbered migration files.

* Every schema change is appended to `db/init.sql` and must be **safe to re-run on every
  boot**. Use `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`, and guarded `DO $$ ... END $$` blocks for anything those
  cannot express.
* `src/config/migrate.js` reads that file and applies it on every boot unless
  `AUTO_MIGRATE=false`. It runs the whole script in one round trip through the simple
  query protocol, so the script must stay parameter free.
* A destructive statement, a `DROP` or a rewriting `ALTER`, is only acceptable inside a
  guard that makes it a no-op once applied. Assume the script runs against a database that
  already holds production rows.
* Existing databases and fresh ones take the same path. Never write a statement that only
  works on an empty database.

Schema documentation for humans lives in
[`../../wiki/information/architecture.md`](../../wiki/information/architecture.md), not in
this file.

## Layers

Request flow is `src/index.js` to `src/app.js` to `src/routes/` to `src/controllers/` to
`src/utils/`, with `src/config/` holding the pool, the environment reader and the migrator.

* **Routes** wire paths to controllers and own middleware such as multer. They contain no
  business logic and no SQL.
* **Controllers** own validation, authorization and SQL. They return responses; they do not
  throw for expected conditions, they `return res.status(...)`.
* **Utils** hold logic shared by more than one controller. Anything both the web path and
  the MCP path need goes here so the two behave identically. File ingestion is the worked
  example: `src/utils/fileIngest.js` is called by both `fileController` and `mcpController`.
* Every source file is CommonJS and opens with `'use strict'`.

## Two authentication paths, never mixed

* `src/middleware/auth.js` verifies a JWT and populates `req.user`. It guards the human
  facing routes under `/api/documents`, `/api/me`, `/api/tokens`.
* `src/middleware/apiToken.js` verifies a per project token and populates `req.apiToken`
  with `{ tokenId, userId, username, projectId, projectTitle }`. It guards `/api/mcp`.

**Security invariant: an MCP controller resolves the acting user and the target project
from `req.apiToken` only, never from the request body.** The MCP surface is driven by a
language model, so any identity or project taken from arguments is a privilege escalation
a prompt injection can reach. Role checks go through `assertProjectAdmin(projectId,
userId)` in `src/controllers/mcpController.js` using those token values. Do not add an
MCP route that accepts a project id, a user id, or a role as a parameter.

## Embeddings

* There is **no server owned OpenRouter key**. Every embedding call spends the acting
  user's own key, decrypted per request by `src/utils/userKeys.js` from
  `user_openrouter_keys`. A missing key is a `412`, never a fallback to someone else's key.
* All outbound embedding traffic goes through `embedText` in `src/utils/embeddings.js`.
  Do not call the OpenRouter endpoint directly from a controller.
* **Content and vectors are separate tables.** `document_chunks` holds the text;
  `document_chunk_embeddings` holds one vector per `(chunk_id, model_name)`. Never add an
  embedding column back to `document_chunks`: that shape is what made a model change
  destroy a knowledge base, and the split is the fix.
* **A model change is additive and must stay that way.** Nothing deletes a vector
  implicitly. Selecting a different model only updates `documents.embedding_model`, and the
  old vectors stay so switching back costs nothing. The only route that removes a vector is
  the explicit delete, and it refuses to touch the model currently selected.
* **Report coverage wherever you report a chunk count.** A chunk with no row for the
  current model is invisible to search, so a bare count makes an uncovered knowledge base
  look empty. Use `src/utils/embeddingCoverage.js` rather than counting chunks inline.
* The `embedding` column is a **dimensionless** `vector` so projects can choose models of
  different sizes, and two models' rows can sit in the table at once. That is why there is
  no HNSW or ivfflat index on it: pgvector's ANN indexes need a fixed dimension. Search
  uses exact KNN with `<=>`, joined on `model_name` so vectors from two models are never
  compared. Do not add an ANN index without first fixing the dimension.
* **Every write to a `model_name` column goes through `normalizeModelName`**, which trims
  and lower-cases, per the shared `agents_model_naming_convention` tool. Enforce the full
  `{platform}/{model}` shape with `isConventionalModelId` where a person chooses a model;
  keep reads tolerant, because an older database may hold a bare name.
* **Backfilling is explicit and batched.** It spends the caller's OpenRouter credits, so
  nothing triggers it implicitly, and it stops at `BACKFILL_BATCH_LIMIT` rather than
  running for minutes. It only inserts, so repeating it is safe.

## Naming

`documents` is the projects table. A project, a document and a knowledge base are the same
row; the table name predates the product naming and is load bearing across the schema, the
API and the client. Do not rename it opportunistically, and do not introduce a second word
for it in new code.

## What must not be introduced

* A second schema source, a migrations directory, or an ORM.
* A global or shared OpenRouter API key, in code, in `.env.example`, or in a default.
* Logging or auditing that records a decrypted API key, a token, or a password hash.
  `src/utils/audit.js` records the actor and the action, never the secret.
* An MCP route whose authorization depends on request arguments.

## Running it

`npm run dev` for a reloading server, `npm start` for a plain one. There is no test suite
and no linter configured, so verification is manual: boot the server against a pgvector
database and exercise the affected route. Say so plainly when reporting work rather than
implying a suite ran.
