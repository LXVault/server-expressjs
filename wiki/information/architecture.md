# Architecture

## Request flow

```
src/index.js          boot: listen, health check, apply schema, graceful shutdown
  src/app.js          CORS, JSON body limit, /health, mount /api, 404, error handler
    src/routes/       path to controller wiring, one file per feature
      src/middleware/   auth (JWT), apiToken (per project), documentAccess
      src/controllers/  validation, authorization, SQL
        src/utils/      shared logic: embeddings, ingestion, crypto, jwt, audit, roles
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

## What one request can cost

Every limit here bounds a single request, and each one exists because the thing it
bounds is unbounded by default. They are deliberately separate limits rather than one
"max request size", because they protect against different things.

| Bound | Value | Why |
|---|---|---|
| JSON body | 100 KB | The MCP file endpoint is the only route that needs more, and it has its own 20 MB parser mounted ahead of this one. |
| Files per upload | 20 × 10 MB | What one request may buffer in memory. |
| Text fields per upload | 10 | A multipart body with a thousand small fields trips neither `fileSize` nor `files`. |
| Parts per upload | 30 | Fields and files together. |
| Bytes per text field | 64 KB | One field can otherwise carry as much as a small file. |
| Header pairs per part | 2000 | Parser-level, before anything is interpreted. |
| Chunks per file | 2000 | Each chunk is one sequential OpenRouter call. This is the bound that turns an 11,000-call upload into a `413`. |
| OpenRouter call | 30 s | `fetch` waits forever without a signal. |
| PDF parse | 15 s | Parsing is CPU work on an attacker-supplied buffer. |

A file that trips the size limit is `413`, not `400`: the request was well-formed and
simply too big, and the two are different signals to a client.

**Authorization runs before the upload is read.** `multer` can only buffer once the
request stream has been consumed, so `requireDocumentWrite` is mounted ahead of it on
`POST /api/documents/:id/files`. Without that ordering a caller with no access to a
project has already made the process allocate the whole upload by the time it is
refused. `src/middleware/documentAccess.js` does the check and hands the result to the
controller, so the query runs once.

## Rate limits

Size limits bound one request; rate limits bound how often. A caller can send sixty empty
requests a minute forever without meeting a single byte limit.

| Surface | Budget | Key | Notes |
|---|---|---|---|
| `/api` generally | 60 / min | address | Everything not listed below. |
| `POST /api/auth/login` | 10 / 15 min | address **and** account | Failures only. A correct password spends no budget, so nobody locks themselves out. |
| `POST /api/auth/register` | 10 / 15 min | address | Keyed on the address alone — the account is what is being created, so keying on it would give every attempt its own budget. |
| `/api/mcp/*` | 120 / min | address | Higher because the caller is a machine making a burst by design. A judgement call, and the number here to revisit first if legitimate assistants get cut off. |
| `GET /api/ping`, `GET /health` | none | — | Liveness probes must not be able to exhaust anything. |

Keying sign-in on the account as well as the address stops both obvious attacks at once: one
address grinding through a list of accounts spends a separate budget per account, and one
account under attack from many addresses spends one budget per address.

The auth and MCP routers are mounted **ahead** of the general limiter in
`src/routes/index.js`, because a `use` that matches ends the walk down that router. That
ordering is what lets the tighter and the larger budgets apply to their own surfaces instead
of both being clamped to 60.

Every one of these rests on `TRUST_PROXY` being right, since it decides whether `req.ip` is
the client or the proxy. See [env.md](../environments/env.md).

## What the error paths say

An error response is the one place a server talks about itself unprompted, so what it is
allowed to say is a deliberate decision rather than whatever `err.message` happened to be.

| Class | Response | Example |
|---|---|---|
| `4xx` | The message this application wrote | `No OpenRouter API key configured for your account` |
| `5xx` in production | `Internal Server Error`, nothing else | — |
| `5xx` in development | The real message | — |

The 4xx branch is safe because the text was authored here, for this caller. The 5xx branch
is not: a `5xx` message came from node-postgres, an upstream API or a library, and those
routinely name tables, columns, constraint names, hostnames and failed credentials.
`duplicate key value violates unique constraint "uq_api_tokens_user_project"` is a free
map of this schema. It goes to the log, where it is useful to whoever is on call.

Three places needed more than that rule, because they sat on the 4xx side while carrying
text from elsewhere:

* **`/health`.** A database error there can read `password authentication failed for user
  "mcp_user"`, which confirms the default credentials published in this repository are live
  and names the internal address. The endpoint is unauthenticated and the most-read one in
  the deployment, so it answers `{"status":"degraded"}` and nothing else.
* **The upload path.** `ingestFile` fails either in this application's own validation or
  inside the PDF parser or OpenRouter. `describeIngestFailure` in `fileController` maps the
  status to wording written here; the real message is logged. The `error` field keeps its
  name, because the web app reads it.
* **Backfill.** The same reasoning, and the upstream's own message is logged rather than
  returned.

**Enumeration is a latency problem as much as a message problem.** The sign-in handler used
to return before `bcrypt.compare` for an account that did not exist, and after it for one
that did. The two `401`s were byte-identical and differed by roughly a hundredfold in
latency, which made the generic message a reliable oracle. Both paths now do exactly one
bcrypt comparison against the same cost factor — against a decoy hash when there is no real
one. Registration and member-add are bounded the other way, by refusing to repeat the probe
back and by the rate limits above.

## Authentication

Two independent paths, never mixed.

Security headers come from `helmet` at the top of the stack, and `X-Powered-By` is
disabled. CORS is a named allow list rather than a wildcard; see
[env.md](../environments/env.md).

| Path | Middleware | Populates | Guards |
|---|---|---|---|
| Human | `src/middleware/auth.js` | `req.user` | `/api/documents`, `/api/me`, `/api/tokens`, `/api/profile`, `/api/analysis` |
| Assistant | `src/middleware/apiToken.js` | `req.apiToken` | `/api/mcp` |

A valid signature is necessary but not sufficient. `requireAuth` checks three things,
because a signed token is only evidence that this server issued it at some point:

1. **It verifies** with `algorithms: ['HS256']` and the expected issuer and audience. Left
   unpinned, a token chooses its own algorithm.
2. **The user still exists.** A token for a deleted account used to keep working until it
   expired, because nothing ever asked.
3. **The `ver` claim still matches `users.token_version`.** This is what makes logout
   revoke: the token carries the version it was signed with, and bumping the column retires
   every outstanding token at once. A stateless JWT cannot otherwise be cancelled — the old
   remedy was rotating the global signing secret, which signs out everyone.

The cost is one indexed primary-key lookup per authenticated request. That is what buys a
session that can actually end.

An MCP controller resolves the acting user and the target project from `req.apiToken`
only. Nothing under `/api/mcp` accepts a project id, a user id, or a role as an argument,
because that surface is driven by a language model and an argument is something a prompt
injection can set.

A project token is a grant, not a standing credential. `requireApiToken` re-checks on every
request that its user still owns or is still a member of the project it names, so removing
someone from a project stops their token on the next request without a separate revoke. It
also carries an expiry, set when the token is issued or rotated. A token therefore cannot
outlive the membership that justified it, and a token copied out of a chat log stops
working on its own within a bounded time.

## Roles

`document_members.role` is one of `viewer`, `editor` or `admin`, ranked in that order.
`src/utils/roles.js` is the only place that ranking is written down, and both questions
the application asks go through it:

| Question | Answer |
|---|---|
| `canWrite(isOwner, role)` | The owner, or `editor` and above. |
| `canAdminister(isOwner, role)` | The owner, or `admin` only. |

Administration is deliberately stricter than writing. An `editor` can change a project and
its knowledge base but cannot grant roles, because an editor who could hand out roles could
promote themselves, which would make the write grant an escalation path rather than a
capability.

**Membership is managed by the owner and by admins, on both paths.** `canAdminister` is the
only test either surface uses, so `POST /api/documents/:id/members`,
`DELETE /api/documents/:id/members/:userId` and `POST /api/mcp/project/members` answer the
same question the same way, and the `canManage` flag the web app reads is the same
`canAdminister` result rather than a second opinion about ownership. The web path used to
be owner-only, which contradicted the role model in `src/utils/roles.js` — where `admin` is
documented as "everything an editor can do, plus member management" — and disagreed with
the MCP path, where an admin already could. An admin who worked through an assistant but
not through the browser was a difference in the interface, not in the authority.

The owner is not a role. It is `documents.owner_id`, passed to these functions as a
separate flag so ownership can never be smuggled through the role column.

**One refusal is not a role question.** `POST /api/mcp/projects` is refused outright, and
deliberately not expressed through either function above. A project token is minted for
one project, and creating a project is not work scoped to that project — so there is no
role whose answer would be correct, and picking one would dress a product decision up as
an authorization rule. The web app still creates projects; see
`POST /api/documents`. See task 11 in the task record.

## API surface

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness plus a database check. Answers only `{"status":"ok"}` or `503 {"status":"degraded"}` — the reason is logged, never returned. |
| `GET /api/ping` | none | Reachability. |
| `POST /api/auth/register`, `POST /api/auth/login` | none | Account creation and JWT issue. |
| `POST /api/auth/logout` | JWT | Bumps the caller's `token_version`, retiring every token signed with the previous value. |
| `GET /api/profile` | JWT | The current user. |
| `GET /api/me/openrouter-key`, `PUT`, `DELETE` | JWT | Status, set and remove the caller's OpenRouter key. The key itself is never returned. |
| `GET /api/documents`, `POST` | JWT | List accessible projects with chunk and file counts; create one. |
| `GET /api/documents/:id`, `PUT` | JWT | Read a project; update title and summary, which needs write access. |
| `GET /api/documents/:id/members`, `POST`, `DELETE /:userId` | JWT | Membership, managed by the owner or an admin. Removing a member also revokes their project tokens. |
| `GET /api/documents/:id/files`, `POST`, `DELETE /:fileId` | JWT | The project's source files. Upload and delete need write access. |
| `GET /api/documents/:id/token`, `POST`, `DELETE` | JWT | The caller's project token. Any member may mint one, including a viewer. |
| `GET /api/documents/:id/embedding-model`, `PUT` | JWT | Read the project's model plus its coverage and stored models; change it as owner or admin. |
| `POST /api/documents/:id/embeddings/backfill` | JWT | Embed the chunks with no vector for the current model, using the caller's own key. Owner or admin. |
| `DELETE /api/documents/:id/embeddings/:model` | JWT | Drop every vector held for one model. Owner or admin, and never the model in use. |
| `GET /api/tokens` | JWT | Every token the caller holds. |
| `GET /api/analysis` | JWT | Aggregates for the web app's charts. |
| `GET /api/mcp/me`, `GET /api/mcp/project` | token | Who and which project this token is bound to. |
| `POST /api/mcp/search` | token | Search. Any member. |
| `POST /api/mcp/knowledge`, `POST /api/mcp/files` | token | Append a chunk, upload a file. Needs write access, checked before the caller's OpenRouter credits are spent. |
| `POST /api/mcp/projects` | token | **Refused, always.** A project token is minted for one project, and creating one is not work scoped to that project. Create it in the web app. |
| `PUT /api/mcp/project/title`, `PUT /api/mcp/project/description` | token | Rename or re-describe the bound project. Needs write access. |
| `POST /api/mcp/project/members` | token | Add a member or change a role. Owner or admin, the same test as the web path. |


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
| `api_tokens` | `id` | A per project execution token, hashed, with its own expiry. Unique on `(user_id, project_id)`. |
| `user_openrouter_keys` | `user_id` | The user's OpenRouter key as ciphertext, IV and auth tag, with the salt and derivation name needed to decrypt it, plus the last four characters for display. |
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

A user's OpenRouter key is encrypted with AES-256-GCM, and the 32-byte AES key it is
encrypted under is derived from `ENCRYPTION_KEY` **per stored row**: every row carries its
own random 16-byte salt, and `ENCRYPTION_KEY` is combined with that salt through scrypt
(`N=2**15`, `r=8`, `p=1`) to produce the key. Salt, derivation name, ciphertext, IV and auth
tag are all stored alongside each other, because a ciphertext without them cannot be
opened.

The per-row salt is what makes this worth doing. With one global derivation, a
stolen ciphertext is attacked together with every other stolen one, and — more to the
point — a single fast hash over `ENCRYPTION_KEY` means a weak `ENCRYPTION_KEY` is
exhausted at whatever rate the attacker's hardware allows. Any string is still accepted
as `ENCRYPTION_KEY`, and the KDF is what makes that acceptable rather than a rule nobody
follows.

Those parameters are not configurable, deliberately: a KDF whose cost can be lowered by
an environment variable is one mis-set variable away from not being a KDF, and the failure
is silent. Derived keys are cached per process, because the derivation is deterministic
and the value is resolved once at require time, so a cache cannot go stale inside a
process lifetime — rotating `ENCRYPTION_KEY` is a restart by definition.

Rows written before this change carry no salt and no derivation name, and still open
through the single unsalted SHA-256 pass they were written with. The first time one is
read it is rewritten under scrypt, so no user is asked to re-enter their key and no
ciphertext stays on the fast derivation indefinitely. That rewrite is best effort and
never fails the caller's request; see `getDecryptedOpenRouterKey` in `src/utils/userKeys.js`.

Rotating `ENCRYPTION_KEY` still makes every stored key undecryptable, so it is set once
per environment and left alone.

Note the contrast with `src/utils/apiToken.js`, which hashes project tokens with a single
SHA-256 and is correct: those are 32 bytes of `crypto.randomBytes`, so there is no
low-entropy secret to stretch. A KDF only earns its cost on a value a human chose.

Passwords are hashed with bcrypt and never decrypted. Project tokens are stored as hashes;
the plaintext is shown once at creation and never again. A user holds at most one token per
project, so re-minting rotates it in place and the previous value stops working at once.

A token is issued for 90 days and is stamped with that expiry at issue and at every
rotation, so no token is a credential that lives forever. It is also re-checked against live
membership on every request, and removing a member deactivates their tokens for that
project. The two are not redundant: the membership check is what makes removal take effect
immediately, and the deactivation is what stops the token working again if the same person
is later re-added to the project.
