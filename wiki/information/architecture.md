# Architecture

## Request flow

```
src/index.js          boot: listen, health check, apply schema, graceful shutdown
  src/app.js          CORS, JSON body limit (20mb), /health, mount /api, 404, error handler
    src/routes/       path to controller wiring, one file per feature
      src/controllers/  validation, authorization, SQL
        src/utils/      shared logic: embeddings, ingestion, crypto, jwt, audit
          src/config/db.js   the pg pool
```

`src/config/env.js` reads every environment variable once, each with a fallback, so the
process boots without a `.env` file. `src/config/migrate.js` applies `db/init.sql` on boot.

## Layers

**Routes** wire paths to controllers and own route level middleware such as multer for
multipart uploads. They hold no SQL.

**Controllers** validate input, authorize the caller, run SQL and return a response. Each
one is a plain async function with an `(req, res, next)` signature and a `try/catch` that
forwards unexpected errors to the central handler in `src/app.js`.

**Utils** hold anything two controllers need. `src/utils/fileIngest.js` is the worked
example: the web upload path and the MCP upload path both call `ingestFile`, so the two
behave identically rather than drifting.

## Authentication

Two independent paths, never mixed.

| Path | Middleware | Populates | Guards |
|---|---|---|---|
| Human | `src/middleware/auth.js` | `req.user` | `/api/documents`, `/api/me`, `/api/tokens`, `/api/profile`, `/api/analysis` |
| Assistant | `src/middleware/apiToken.js` | `req.apiToken` | `/api/mcp` |

An MCP controller resolves the acting user and the target project from `req.apiToken`
only. Nothing under `/api/mcp` accepts a project id, a user id, or a role as an argument,
because that surface is driven by a language model and an argument is something a prompt
injection can set.

## API surface

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness plus a database check. |
| `GET /api/ping` | none | Reachability. |
| `POST /api/auth/register`, `POST /api/auth/login` | none | Account creation and JWT issue. |
| `GET /api/profile` | JWT | The current user. |
| `GET /api/me/openrouter-key`, `PUT`, `DELETE` | JWT | Status, set and remove the caller's OpenRouter key. The key itself is never returned. |
| `GET /api/documents`, `POST` | JWT | List accessible projects with chunk and file counts; create one. |
| `GET /api/documents/:id`, `PUT` | JWT | Read a project; update title and summary as owner or admin. |
| `GET /api/documents/:id/members`, `POST`, `DELETE /:userId` | JWT | Membership, managed by the owner. |
| `GET /api/documents/:id/files`, `POST`, `DELETE /:fileId` | JWT | The project's source files. Upload and delete need owner or admin. |
| `GET /api/documents/:id/token`, `POST`, `DELETE` | JWT | The caller's project token. |
| `GET /api/documents/:id/embedding-model`, `PUT` | JWT | Read the project's model plus its coverage and stored models; change it as owner or admin. |
| `POST /api/documents/:id/embeddings/backfill` | JWT | Embed the chunks with no vector for the current model, using the caller's own key. Owner or admin. |
| `DELETE /api/documents/:id/embeddings/:model` | JWT | Drop every vector held for one model. Owner or admin, and never the model in use. |
| `GET /api/tokens` | JWT | Every token the caller holds. |
| `GET /api/analysis` | JWT | Aggregates for the web app's charts. |
| `GET /api/mcp/me`, `GET /api/mcp/project` | token | Who and which project this token is bound to. |
| `POST /api/mcp/search`, `POST /api/mcp/knowledge`, `POST /api/mcp/files` | token | Search, append a chunk, upload a file. |
| `POST /api/mcp/projects` | token | Create a project owned by the token's user. |
| `PUT /api/mcp/project/title`, `PUT /api/mcp/project/description`, `POST /api/mcp/project/members` | token | Mutate the bound project as owner or admin. |

## Database schema

PostgreSQL with the `vector` extension. Defined entirely in `db/init.sql`.

| Table | Key | Holds |
|---|---|---|
| `users` | `id` | Account, unique username and email, bcrypt password hash. |
| `documents` | `id` | A project: owner, title, summary, `embedding_model`. |
| `document_members` | `(document_id, user_id)` | Membership and role. |
| `document_files` | `id` | An uploaded source file and its chunk count. |
| `document_chunks` | `id` | A slice of text. Content only. Cascades from both the project and the file. |
| `document_chunk_embeddings` | `(chunk_id, model_name)` | One vector per chunk per embedding model, with the dimension it came out at. Cascades from the chunk. |
| `api_tokens` | `id` | A per project execution token, hashed. Unique on `(user_id, project_id)`. |
| `user_openrouter_keys` | `user_id` | The user's OpenRouter key as ciphertext, IV and auth tag, plus the last four characters for display. |
| `audit_logs` | `id` | Actor, token, action type, target and details. |

Three schema decisions worth knowing:

* **Content and vectors are separate tables.** A chunk's text is written once, while a
  vector exists per embedding model, and a project may change model at any time. Holding
  both in one row meant a chunk could carry exactly one model's vector, so changing the
  model made the whole knowledge base unsearchable until it was deleted and re-uploaded.
  Keyed on `(chunk_id, model_name)`, a model change is additive: the previous model's
  vectors stay, switching back is instant, and the only cost of a new model is embedding
  the chunks that have no row for it yet.
* **`document_chunk_embeddings.embedding` is a dimensionless `vector`.** Projects choose
  models of different sizes, and two of them can hold rows in this table at the same time,
  so a fixed dimension is not available. The cost is that pgvector's HNSW and ivfflat
  indexes cannot be used, since they require one, so search runs an exact KNN with `<=>`.
  That is acceptable at the current scale.
* **`api_tokens.project_id` references `documents(id)`** through a constraint added after
  the table, because the two tables reference each other in definition order.

## Coverage

Because a chunk is only searchable when it has a vector for the project's *current* model,
a chunk count on its own is misleading: an uncovered knowledge base and an empty one look
identical from a search result. Every endpoint that reports on a project therefore reports
coverage as well, meaning the total chunks, how many are embedded with the selected model,
and how many are still pending. `src/utils/embeddingCoverage.js` owns those two queries.

Backfilling is explicit rather than automatic. Changing the model is instant and spends
nothing, and the separate backfill call is what spends the caller's OpenRouter credits, in
batches of 100 chunks so one request cannot run for minutes. It only ever inserts, so
repeating it is safe and is how a large project is covered.

## Schema application

There is no migration tool. `db/init.sql` is written so that every statement is safe to
re-run, using `IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` and guarded `DO` blocks, and
`src/config/migrate.js` executes the whole file on every boot unless `AUTO_MIGRATE=false`.
That keeps managed databases such as Render Postgres, which offer no init container hook,
in sync without a manual step.

The whole script goes through node-postgres in one `pool.query(sql)` call, which uses the
simple query protocol and therefore executes every statement, including the dollar quoted
`DO` blocks, in a single round trip. It also means the script may contain no bind
parameters.

## Model identifiers

A stored model name follows the shared `{platform}/{model}` convention and is lower-cased
before it is written, so `OpenAI/Text-Embedding-3-Small` and
`openai/text-embedding-3-small` cannot both exist as rows for one chunk.
`normalizeModelName` in `src/utils/embeddings.js` is the single place that decides the
canonical spelling, and every write goes through it.

The convention is enforced where a person *chooses* a model, so nothing new enters the
system without a platform segment. Reads stay tolerant, because a database written before
that was enforced may hold a bare name and its chunks must keep working.

## Secrets

`ENCRYPTION_KEY` is run through SHA-256 to derive a stable 32 byte key, which AES-256-GCM
uses to encrypt each user's OpenRouter key. Ciphertext, IV and auth tag are stored in
separate columns. Rotating `ENCRYPTION_KEY` makes every stored key undecryptable, so it is
set once per environment and left alone.

Passwords are hashed with bcrypt and never decrypted. Project tokens are stored as hashes;
the plaintext is shown once at creation and never again.
