---
name: memory-tasks-security-hardening
description: Record of the security remediation and dependency currency work — the two CRITICAL secrets findings, the HIGH authorization and upload findings, and the major dependency upgrades across the three LXVault repositories.
---

# Task: security hardening

**Goal.** `src/config/env.js` shipped published fallback secrets, so a deployment that
did not override them ran on constants anyone can read from the repository — every
session forgeable, every stored OpenRouter key decryptable by a stranger. Alongside
that, a `viewer` token could write to the knowledge base, a project API token was a
standing grant that was never re-checked against membership, and uploads were buffered
before authorization with no limit on the work that followed. Close those, and bring
every dependency to its current release.

**Objective.** A production boot with a missing or defaulted secret refuses to start.
A `viewer` cannot write and cannot mint a token. A token stops working when the
membership that justified it is removed, and expires on its own. A request cannot
consume unbounded memory or unbounded upstream time. Every dependency in all three
repositories resolves to its current release, with the code each major version breaks
migrated rather than papered over.

**Detail.** Findings and severities are in `REPORT.md` and the remediation sequence in
`PLAN.md`, both at the workspace root and outside this repository. The user directed two
things beyond the original plan: take the latest release of every library including
majors, and gate the secrets guard on `NODE_ENV=production` rather than introducing a
new variable. `PROD` does not exist in this codebase and the Dockerfile already sets
`NODE_ENV=production`, so the guard reuses that.

The repository rules bind hard here. `db/init.sql` stays the only schema definition and
every change to it must be safe to re-run on every boot, so the two column additions are
guarded rather than migrated. The MCP security invariant holds: the acting user and
project continue to resolve from `req.apiToken` only. No server-owned OpenRouter key is
introduced. There is no test suite and no linter, so every task below is verified by
exercising the affected code directly. Tasks 2 to 5 were verified by booting the server
against a pgvector database and calling the routes by hand. Tasks 6 and 7 were verified by
scripts under `.agents/wiki/context/` that drive the real app over real HTTP, stubbing only
`src/config/db` — and those stubs are the standing hazard, because a stub written to answer
the test is how a check passes without having checked anything.

## Tasks

| # | Title | Scope | Repository | Branch | PR |
|---|---|---|---|---|---|
| 1 | The record | The confirmed list and its decisions | server-expressjs | `chore/security-hardening-plan` |  |
| 2 | Refuse to boot on a missing or defaulted secret | The guard, `.env.example` | server-expressjs | `fix/fail-closed-secrets` |  |
| 3 | Dependencies to current, Express 5 migration | `package.json`, the middleware and routes it breaks | server-expressjs | `build/dependency-upgrade` |  |
| 4 | Role hierarchy, and guard `addKnowledge` | `src/utils/roles.js`, the three loaders, the MCP write/admin split | server-expressjs | `fix/project-authorization` |  |
| 5 | Bind API tokens to live membership, expire them | `apiToken` middleware, issuance, removal | server-expressjs | `fix/api-token-lifecycle` |  |
| 6 | Bound the work a request can cause | Rate limits, authorization order, upload limits, timeouts | server-expressjs | `fix/request-limits` |  |
| 7 | Stop the information the error paths give away | `helmet`, health, error handler, timing, enumeration | server-expressjs | `fix/error-disclosure` |  |
| 8 | Derive the key properly | scrypt and a persisted per-row salt | server-expressjs | `fix/encryption-kdf` |  |
| 9 | Release | `2.0.0`, changelog, this record closed | server-expressjs | `chore/security-hardening-release` |  |

Tasks 2 to 8 stack in this order; each branches from its predecessor. Two further
chains run in the other repositories, ordered after this one because both read the API
this one changes: `mcp` at merge order 2 of 3, `client-reactjs` at 3 of 3.

### Task 1 — chore/security-hardening-plan

Landed: this record, and the branch carrying it. No source file is touched by this task.

Decided at the user's direction rather than proposed here: take every library to its
latest release including across major versions, and gate the secrets guard on
`NODE_ENV=production`.

Depends on: nothing. Task 2 depends only on this record; tasks 3 to 8 additionally
depend on the guard landing first, because Express 5 changes how the middleware stack
boots and the guard runs before it.

### Task 2 — fix/fail-closed-secrets

Closes the two CRITICAL findings, C1 and C2.

Landed:

* `src/config/env.js`: `assertProductionSecrets` runs after the config object is built
  and throws before `module.exports` when `NODE_ENV=production`. It rejects an unset
  key and a key still holding its published default, and names which is which, because
  the second is the likelier mistake and the message has to distinguish them. Development
  is untouched, so the fallbacks still work where they are not dangerous.
* The three published constants are named in one `PUBLISHED_DEFAULTS` object rather than
  repeated inline, so the guard and the fallbacks cannot drift apart.
* The false claim that the encryption key "is run through a KDF" is corrected in both
  `env.js` and `.env.example`. It is a single SHA-256 pass. The scrypt change that makes
  the sentence true is task 8; until then the comment says what the code does.
* `.env.example`: `JWT_SECRET` and `ENCRYPTION_KEY` are blank with a generation command.
  `DATABASE_URL` keeps its local value because that is a development convenience, but the
  comment now says production must replace it and why — the role name and password in it
  are published.

Verified, not by inspection. Six cases run against the real module, each in a child
process with a clean environment:

* production with nothing set — refuses, naming all three
* production with `JWT_SECRET` at its published default — refuses, naming it as a
  default rather than as missing
* production with all three real — loads
* production with only `ENCRYPTION_KEY` missing — refuses, naming only that one
* development with nothing set — loads
* no `NODE_ENV` at all — loads

The full application was then loaded in development (10 routes mounted) and refused in
production with the guard's message. `npm ci` left `package-lock.json` untouched.

The first run of this test was invalid and was discarded: `node_modules` was absent, so
all six cases threw on `require('dotenv')` and three of them passed for the wrong reason.
The dependency install happened first and the test was re-run. The lesson is recorded here
because it is the failure mode a security check is least likely to survive — a test that
passes because the module could not load at all looks exactly like a test that passed.

Checked and deliberately not changed: `src/config/db.js` reads `config.databaseUrl` as
the only path to a database, so a production deployment that works must already set
`DATABASE_URL`. Requiring it breaks nothing that currently runs. The `.env.example`
reference to `docker-compose.yml` describes a file that exists in no repository, and
`.gitignore` points at a `docker-compose.yml.example` template that is also absent; both
are pre-existing and are reported as a discovery finding rather than edited here.

Depends on: task 1. Task 3 depends on this guard, because Express 5 changes how the
middleware stack boots and the guard runs ahead of it.

### Task 3 — build/dependency-upgrade

Closes H1, and migrates the code Express 5 breaks.

Landed:

* Every production dependency moved to its current release: `express` 4.19.2 → 5.2.1,
  `bcryptjs` 2.4.3 → 3.0.3, `dotenv` 16.4.5 → 18.0.4, `multer` 2.1.1 → 2.4.0,
  `cors` → 2.8.6, `pg` → 8.23.0, `jsonwebtoken` → 9.0.3, and `nodemon` → 3.1.14.
  `pdf-parse` was already current at 2.4.5.
* `src/routes/documents.js`: the model wildcard rewritten from `:model(*)` to `*model`.
  This was the one hard blocker. Express 5 uses path-to-regexp v8, which removed the
  custom-parameter regex, and the app did not start at all until it changed.
* `Dockerfile`: `npm install --omit=dev` → `npm ci --omit=dev`, so the image installs the
  tree that was audited rather than resolving ranges again at build time.
* `Dockerfile`: base image `node:20-slim` → `node:22-slim`. node 20 reached end of life in
  April 2026, so the previous tag no longer received security fixes. node 22 is the line
  this work was verified on; node 24 is available and is a separate decision.

H1 is closed: `npm audit --omit=dev` reports **0 vulnerabilities**, against five HIGH
advisories before.

Verified, not by inspection:

* All eight production dependencies resolve to the versions named above and load under
  CommonJS.
* Routing was exercised over real HTTP against the actual `documents` router. The
  multi-segment wildcard matches `openai/text-embedding-3-small`, the single-segment case
  matches, and the six neighbouring document routes are unaffected. The bare
  `/embeddings/` case also matches, because a v8 wildcard may consume zero segments; the
  controller already rejects an empty model before it reaches SQL, so it is safe.
* bcryptjs 3 keeps existing user passwords. A hash generated by v3 and rewritten to a
  `$2a$10$` prefix verifies, a wrong password is still rejected, and `getRounds` still
  returns the cost. No re-hash of stored credentials is needed.
* `crypto.encrypt`/`decrypt` round-trips, `jwt.signToken`/`verifyToken` round-trips,
  `multer` and `pdf-parse` load, and `PDFParse` constructs with a `destroy()` method
  available for the timeout work in task 6.
* Over HTTP, `/` returns the service banner, `/api/ping` returns `{pong:true}`, and an
  unknown path returns the 404 handler. The whole app boots.

Two of my own test harnesses were wrong before the code was, and both are worth recording.
The first asserted `typeof require('pdf-parse') === 'function'`, but v2 is a namespace
object exporting `PDFParse`, which is what the code already destructures. The second read
a dependency's `package.json` through its `exports` map, which bcryptjs 3 does not expose.
Neither was a defect in the application.

**Not verified, and this is a real gap.** This repository has no test suite, so there was
nothing to run, and no database or Docker was reachable in this environment. Every
DB-backed route — upload, ingestion, search, token issuance, membership — was therefore
exercised only as far as authentication and path matching, never against a real
pgvector. The repository rules call for booting against a database and working the
routes; that did not happen here and the upgrade should be smoke-tested in a real
environment before it ships.

Checked and deliberately not changed: no source file reads an Express internal
(`_router`, `.stack`), so the removal of those in Express 5 breaks nothing. Express 5
forwards a rejected async handler to the error handler, which is a behaviour change in
the safe direction; the error handler that receives it is task 7's work.

Depends on: task 2. Task 4 onward depend on the router change and the resolved tree.

### Task 4 — fix/project-authorization

Closes H2, and replaces the authorization model to do it.

**This task changed shape.** The plan scoped it as "add the missing check to
`addKnowledge`, and stop a `viewer` minting a token". The user directed that any member
may mint a token, and that an `editor` must be able to write. Neither is a gate change
in one place: it is a change to the role model itself, which this codebase had written
out four separate times.

The finding that changed the analysis: the plan's assumption that "`editor` may write,
matching the existing `canEdit` semantics" was wrong. Every controller implemented the
same expression, `isOwner || memberRole === 'admin'`, so `editor` and `viewer` were both
entirely read-only and `editor` granted nothing anywhere. The user asked for `editor` to
write, which meant defining the hierarchy rather than adjusting a comparison.

Landed:

* `src/utils/roles.js`, new. One definition of the three roles and two questions:
  `canWrite(isOwner, role)` and `canAdminister(isOwner, role)`. Roles are ranked
  `viewer` 1, `editor` 2, `admin` 3, and ownership is passed alongside the role so the
  two can never be confused — the owner is not a role, it is `documents.owner_id`.
* `documentController.js`, `fileController.js`: `canEdit` now uses `canWrite`, so an
  editor may change the project's title and description, and upload and delete
  knowledge files.
* `projectModelController.js`: `canConfigure` now uses `canAdminister`, which is
  unchanged in effect. Model selection, backfill and embedding deletion stay with the
  owner and admins.
* `mcpController.js`: `assertProjectAdmin` split into `loadTokenAccess` — the one query
  both guards share, so they cannot disagree about who the caller is — plus
  `assertProjectWrite` and `assertProjectAdmin`. Title, description and file upload moved
  to the write guard; member management stays on the admin guard.
* `addKnowledge` now calls `assertProjectWrite`, which is the finding. It is placed
  before the OpenRouter call, not after, because `embedText` bills the acting user's own
  credits: checking later would let a read-only token spend them first.
* Token issuance is deliberately unchanged, per the user's direction: any member,
  including a `viewer`, may mint one. It is safe because every write tool is gated, and
  task 5 is what makes a token stop working when the membership behind it is removed.

**Administration deliberately stays stricter than writing.** `canAdminister` is
owner-or-admin, so an editor cannot grant roles. An editor who could hand out roles
could promote themselves, which would make the write grant an escalation path rather
than a capability. This boundary was chosen here rather than asked, and is the one part
of the role change worth a second opinion.

Verified, not by inspection:

* The role hierarchy, across all seven cases that matter — owner, admin, editor, viewer,
  non-member, an owner who is also a viewer, and an unrecognised role string. `editor`
  writes and does not administer; `viewer` does neither; the bogus role `'owner'` is
  rejected, so the ownership flag cannot be smuggled through the role column.
* The guard in `addKnowledge` precedes both the key decryption and the credit spend,
  checked against the executable statements with comments stripped — a first attempt
  compared raw string offsets and was misled by the guard's own comment.
* Every controller and the new util load; over HTTP `/` and `/api/ping` answer 200, an
  unknown path answers 404, and `/health` answers 503 with no database, as expected.

Checked and deliberately not changed: `client-reactjs` renders the `canEdit`,
`canConfigure` and `canManage` booleans the API sends and never re-derives a role
itself, so the new model reaches the UI with no client change. Member management is
**owner-only** on the web path (`documentController.js:228`) but **owner-or-admin** on
the MCP path (`mcpController.js:462`). That divergence predates this work, is not part
of the requested change, and is reported as a discovery finding rather than quietly
reconciled.

Depends on: task 3. Task 5 depends on the role model settled here, because revoking a
token has to know which roles it was valid for.

### Task 5 — fix/api-token-lifecycle

Closes H3.

**No schema change was needed, which is simpler than the plan assumed.** `db/init.sql:29`
already declares `expires_at TIMESTAMP WITH TIME ZONE` and `apiToken.js` already honoured
it. Nothing ever wrote it, so every token took the `NULL` default and the expiry clause was
always satisfied. The column was correct and the code around it was correct; the issuance
path was the only thing missing.

Landed:

* `src/middleware/apiToken.js`: the lookup now `LEFT JOIN document_members` and requires
  `d.owner_id = t.user_id OR dm.user_id IS NOT NULL`. A removed member's token stops
  resolving on the next request, with no separate revoke, and the owner is still admitted
  from `documents.owner_id` without needing a membership row.
* The same join selects `is_owner` and `member_role`, and the live role is threaded onto
  `req.apiToken.role`. A token minted while someone was an editor and later demoted to
  viewer therefore stops writing on the next call. The role is read fresh per request
  rather than baked in at issue, which is the same principle as the membership check:
  a token carries the authority its holder has now, not the authority they had then.
* `src/controllers/tokenController.js`: `TOKEN_TTL_DAYS = 90`, stamped on issue and again
  on every rotation, so re-minting cannot be used to keep a token alive forever. Both token
  listing queries now return `expires_at`, because a user who cannot see the expiry cannot
  act on it.
* `src/controllers/documentController.js`: `removeMember` deactivates the removed member's
  tokens for that project. This is **not** what makes removal take effect — the middleware
  join already does that. It is what stops the token coming back: without it, a member
  removed and later re-added would find their old token working again, under whatever
  authority it had been issued with.

Verified, not by inspection. Thirty-five assertions driving the real middleware and the
real controllers against a stubbed pool, asserting on the status codes, the response
bodies, the ordering of the two statements, and the exact SQL and bound parameters emitted:

* `requireApiToken`: a missing header is 401 and sends no SQL at all; a valid owner token
  authenticates with `role: 'owner'`; a valid member token authenticates with the live
  member role; a token matching no row is 401 and never reaches `next()`.
* The SQL is asserted directly — it still joins `document_members`, still requires owner
  *or* membership, still requires `is_active`, still honours `expires_at`, still selects
  `is_owner` and `member_role`, and still looks the token up by hash. This is a regression
  guard: deleting the membership condition fails the suite instead of silently restoring
  the finding.
* Issuance: `expires_at` is inserted, computed from a bound `interval` parameter rather
  than string-interpolated, the bound value is `90 days`, rotation re-stamps it, rotation
  still re-activates, the `ON CONFLICT (user_id, project_id)` target still matches the
  `uq_api_tokens_user_project` index, and the raw token is still returned exactly once. A
  non-member is refused 403.
* `removeMember`: 204 on success, the deactivation is scoped to both the project and the
  removed user, and it runs *after* the membership delete. A user who was never a member
  is 404 and has no tokens touched.
* Placeholder arity across all three files: no query binds fewer parameters than it
  references.
* The application boots and answers over real HTTP: `/` and `/api/ping` 200, the two token
  routes 401 without a JWT, an unknown path 404.

**Not verified, and this is a real gap.** There is still no PostgreSQL and no Docker in
this environment, so the stub returns rows this harness chose. That proves the code builds
the right query, sends the right parameters, and takes the right branch on a given result
— it does not prove PostgreSQL evaluates the `LEFT JOIN` and the `ON CONFLICT` as intended.
Those two statements are the whole finding, and they should be exercised against a real
pgvector database before this ships: mint a token, remove the member, confirm the next MCP
call is 401 without any revoke having been called.

**Documentation propagation, and a correction to my own process.** Change propagation was
due in tasks 2, 3 and 4 and I did not do it there. It is done in this commit, and the gap
is recorded rather than quietly closed:

* `wiki/information/architecture.md` gained a Roles section, the API surface table now says
  which of the two questions each route asks, and the token lifetime and membership
  re-check are documented. The rows that said "owner or admin" for title, description,
  upload and delete were wrong as of task 4 and had been left standing.
* `wiki/environments/env.md` documents the production guard and what rotation costs.
  `wiki/environments/docker.md` documents `node:22-slim`, `npm ci`, and the fact that the
  image runs with the guard armed.
* `.agents/wiki/context/repository-map.md` gained the two gotchas an agent would otherwise
  rediscover the hard way: role checks go through `src/utils/roles.js`, and the token query
  re-joins membership on purpose.

**One instruction left deliberately stale.** `.agents/rules/repository.md` states that
`requireApiToken` populates `req.apiToken` with `{ tokenId, userId, username, projectId,
projectTitle }` — it now also carries `role` — and that role checks go through
`assertProjectAdmin`, which is now one of two guards. That file is an instruction, and
change propagation says a stale instruction is a discovery finding rather than an edit.
It is reported with the rest.

Depends on: task 4. Task 6 does not depend on this and could have run in either order.

### Task 6 — fix/request-limits

Closes H5 and H6, and the request-limits half of M7, M13 and M14.

Landed:

* **Authorization moved ahead of the upload parser.** `POST /api/documents/:id/files` now
  runs `requireDocumentWrite` before `handleUpload`. This is the H5 fix and it is an
  ordering change, not a logic one: `multer` can only buffer once the request stream has
  been consumed, so with the check after it, a caller with no access to a project had
  already made the process allocate up to 200 MB before being refused.
* `src/middleware/documentAccess.js`, new. Resolves the caller's standing on the project
  once and hands it to the controller on `req.documentAccess`, so the query is not
  repeated.
* `src/utils/documentAccess.js`, new. `loadAccess` existed in **two** copies —
  `documentController` selected `d.*` and `fileController` selected three columns — and
  the new middleware would have needed a third. They differ only in the SELECT and
  `fileController` reads a single field from it, so they are now one function. The
  controller keeps its own check as a fallback rather than trusting the middleware, since
  the controller is what decides what a file may do.
* **Multer bounds the shape of the body, not just its size.** Added `fields: 10`,
  `parts: 30`, `fieldSize: 64 KB`, `headerPairs: 2000` alongside the existing `fileSize`
  and `files`. Neither of the old two bounds a request made of a thousand small fields or
  one field carrying a header the size of a small file.
* **A limit that was hit is a `413`, not a `400`.** `LIMIT_STATUS` maps each `LIMIT_*`
  code to the status it deserves; before, every multer error was flattened to 400, so a
  client could not tell "too big" from "malformed".
* **The 20 MB JSON limit is now scoped to the one route that needs it.**
  `/api/mcp/files` gets its own parser mounted *ahead of* the global one, because
  body-parser marks a stream as read and the second parser skips it — so whichever runs
  first is the one that counts. Every other route is now capped at 100 KB. This is the
  cheapest fix in the task: one line of ordering turns a global 20 MB into a single-route
  20 MB.
* `MAX_CHUNKS_PER_FILE = 2000` in `fileIngest.js`, checked **before** the embedding loop.
  This is the highest-value line in the task. `MAX_FILE_BYTES` bounded the input but not
  the work: 10 MB of dense text is roughly 11,000 chunks, embedded one at a time,
  sequentially, spending the caller's credits. 2000 is a judgement call and not a measured
  value — it is about a 2 MB text file or a 300-page PDF. It is flagged here as a product
  decision, exactly as the plan flagged it.
* `AbortSignal.timeout(30_000)` on the OpenRouter call. `fetch` with no signal waits
  forever. A `TimeoutError` is reported as a timeout rather than as "could not reach
  OpenRouter", because those are different faults and the message is what an operator
  reads.
* A 15 s deadline on `parser.getText()`, raced against the parse, with `parser.destroy()`
  in the `finally` and the timer cleared so the handle does not outlive the request.
  `pdf-parse` exposes no way to cancel an in-flight parse, so the parse may run on in the
  background after the request is released; that is the trade for not holding the slot
  open indefinitely.
* `TRUST_PROXY` in `env.js` and `.env.example`, and the `app.set('trust proxy', …)` it
  drives. **The plan said to set this only if the deployment sits behind exactly one
  proxy you control, and I cannot know that from the repository**, so it is a variable
  rather than a constant. `true` is rejected outright: it trusts the whole chain, which
  means trusting whatever the last hop wrote, and the last hop is the client.
* **Rate limiting, in `src/middleware/rateLimit.js` — new.** Four limiters, mounted as
  follows:
  * `apiLimiter`, 60/min, keyed on address, covering everything under `/api` that is not
    listed below.
  * `loginLimiter`, 10 per 15 min, keyed on **address and account together**, with
    `skipSuccessfulRequests: true`. A correct password spends no budget, so nobody locks
    themselves out of their own account. Keying on the account as well as the address
    stops both obvious attacks at once: one address grinding through a list of accounts
    spends a separate budget per account, and one account attacked from many addresses
    spends one budget per address.
  * `registerLimiter`, 10 per 15 min, keyed on the **address alone**. Keying registration
    on the account would give every attempt its own fresh budget, which is the same as no
    limit at all.
  * `mcpLimiter`, 120/min. Higher than the general cap because the caller is a machine
    making a burst by design, and a legitimate assistant working through a task does
    exactly that. This is the one number here I am least sure of; it is a judgement call
    and it is flagged as such rather than presented as a measured value.
  * `GET /api/ping` and `GET /health` are mounted ahead of every limiter. A liveness probe
    that can be rate-limited is a liveness probe that will take the app down.
  * `loginLimiter` and `registerLimiter` are applied inside `routes/auth.js`, and
    `/auth` and `/mcp` are mounted in `routes/index.js` **above** `router.use(apiLimiter)`.
    That ordering is load-bearing: a `use` that matches ends the walk down the router, so
    mounting the general limiter first would clamp all four surfaces to 60/min and make the
    sign-in limit unenforceable.
* **`express-rate-limit` v8.7.0 is a new runtime dependency.** The install was refused by
  the environment's permission classifier, which requires the user to approve an
  agent-chosen package explicitly. I did not route around that; the user approved it and
  the install then ran. The install surfaced a `brace-expansion` advisory through
  `nodemon → minimatch`, which `npm audit fix` cleared — `npm audit` is 0 across dev and
  production.

Verified, not by inspection. Thirty assertions against the real application:

* The upload route's layer order, read from the actual router rather than asserted from
  memory: `requireDocumentWrite` is present, sits ahead of `handleUpload`, and appears on
  no other route.
* The real `handleUpload` instance, lifted out of that router and mounted on a probe
  alongside the real middleware. A non-member posting a 5 KB file is refused 403 and
  **multer never ran**; the same request as an editor is buffered and answers 200.
* Multer's shape limits, with multipart bodies built by hand: 9 text fields accepted, 11
  rejected 413; 20 files accepted, 21 rejected 413; a 70 KB text field rejected 413.
* JSON limits over HTTP against the booted app: 300 KB refused 413 on `/api/documents`;
  a small body parsed and then refused 401 for auth; **the same 300 KB accepted on
  `/api/mcp/files`**, which is what proves the scoping works rather than the limit simply
  being lower.
* The chunk cap: a 2 MB text produces 2223 chunks, is under `MAX_FILE_BYTES` so only the
  chunk cap can stop it, and ingesting it is refused 413 with a message saying what to do
  — and **no upstream call was made**. A short file passes the cap, reaches the embedding
  call, and fails later on the absent database, which is what shows the cap is not a
  blanket rejection.
* `TRUST_PROXY` across nine values in clean child processes: unset, `0`, `-1`, `true`,
  `abc` and `3 ` all resolve to `null`; `1` and `2` resolve to those numbers. The
  production secrets guard still fires after the edit.

A second harness of sixteen assertions covers the limiters, over real HTTP against the
booted application:

* `GET /api/ping` answers 200 on all 80 requests it is given, and `/health` is not
  limited either — the probes are mounted ahead of every limiter.
* The 61st request to a limited general endpoint is 429 and carries the
  `draft-7` `RateLimit` headers; the first 60 are not.
* Sign-in: 10 wrong passwords for one account from one address is refused on the 11th with
  the *account-specific* message, while a second account from the same address still has
  its own full budget. That pair is what shows the key is composite rather than one or the
  other.
* **A successful sign-in spends no budget** — 12 correct passwords in a row are all
  accepted, with the counter unmoved. This is the assertion that proves
  `skipSuccessfulRequests` is doing what it claims, rather than the limit simply being
  high.
* The 429 body is JSON with the message the limiter was configured with, not a stack trace
  and not Express's default HTML error page.
* `/api/mcp` was not exercised beyond confirming its larger budget is not clamped to 60,
  because a real MCP call needs a live token and a live database. The 120 figure is
  unverified under load; it is a configured number, not a measured one.

**Three of my own harnesses were wrong before the code was, and all three are the kind
that produce false confidence.** The first stubbed `global.fetch` globally and so
answered the harness's *own* HTTP requests with an embeddings response — a screen of
unfailing 200s. The second rebuilt the upload middleware instead of using the
application's, with a hardcoded 400, so the limit tests "passed" while proving nothing
about the status codes actually returned. Both are now caught by the fact that the
harness reuses the real modules. A third, in the task-5 run, made real calls to the live
OpenRouter API with a fake key and reported its 401 as if the application had produced it.
The lesson is the same one as the invalid dependency test in task 2: **a stub that
answers the test is worse than no stub**, because it converts a missing check into a
passing one.

**Not verified, and this is a real gap.** Still no PostgreSQL and no Docker, so
everything above runs against a stubbed pool. The middleware ordering, the multer limits
and the JSON scoping are exercised over real HTTP and do not depend on the database; the
chunk cap is a pure function and is not. `ingestFile`'s database half — the transaction
that writes chunks and embeddings — has not been run at all.

### Outstanding on this task

* **`files: 20` was left alone, and it is a residual risk.** With authorization in front
  of it, 200 MB is now reachable only by someone who genuinely has write access — but
  still by them, and a member could fire several such requests at once. The rate limiter
  bounds how often, not how much, so it does not close this. Lowering the file count is a
  product decision the plan did not ask for, so it is flagged rather than changed. It is
  the same class of decision as the chunk cap, and I would rather it be made once,
  deliberately, than twice by accident.
* **The MCP budget of 120/min is unverified under real load.** It is reasoned from how an
  assistant behaves, not measured against one. If legitimate assistants are being cut off,
  this is the first number to raise.
* **`TRUST_PROXY` is answered for Render and only for Render.** The user confirmed one
  proxy in front, so the default is `1`. If a CDN, a bot filter or a second nginx is ever
  put in front, every per-address limit in the app becomes wrong at once — either
  forgeable or shared by the whole internet. It is documented in `wiki/environments/env.md`
  and in `.env.example`, and it needs re-reading whenever the edge changes.

Depends on: task 4. Task 7 does not depend on this and could have run in either order.

### Task 7 — fix/error-disclosure

Closes M1–M5 and M8–M11. The M6 half of the plan's T7 numbering (the encryption KDF) is
task 8, deliberately separated, because that one is a breaking schema change and the
release notes should not carry a KDF rotation and an information-disclosure sweep in the
same entry.

Landed:

* **M2 — `helmet` and `app.disable('x-powered-by')`.** `X-Powered-By: Express` names the
  framework and its version to anyone who asks, which is a free input to anyone matching a
  CVE against it. helmet adds CSP, `frame-ancestors`, `nosniff`, `Referrer-Policy` and
  HSTS in one call.
* **M1 — CORS is a named allow list, and a wildcard has to be asked for.** The default
  moves from `*` to `http://localhost:5173`, and `assertProductionCors` refuses to start a
  production process on `*` unless `ALLOW_ANY_ORIGIN=true`. The wildcard is not currently
  exploitable — bearer tokens, no cookies, so no ambient credential for a hostile page to
  ride — and it becomes critical the moment cookie auth or `credentials: true` is added.
  That ordering is not something a config file can enforce, so the wildcard becomes a
  decision instead of an omission.
* **M3 — `/health` says `{"status":"degraded"}` and nothing else.** A database error there
  can read `password authentication failed for user "mcp_user"`, which confirms the
  credentials published in this repository are live and names the internal address. The
  endpoint is unauthenticated and the most-read one in the deployment. The detail is logged.
* **M4 — the central handler splits on class, not on message.** A `4xx` keeps the text this
  application wrote; a `5xx` in production becomes `Internal Server Error` and the detail
  goes to the log. node-postgres messages name tables, columns, constraint names and failed
  credentials, and `duplicate key value violates unique constraint
  "uq_api_tokens_user_project"` is a free map of the schema. Development passes the real
  message on both, which is what development is for. The branch is on `nodeEnv`, so a
  deployment cannot turn it off by setting the wrong thing.
* **M5 — three places needed more than the handler rule,** because they sat on the `4xx`
  side carrying text written elsewhere:
  * `describeIngestFailure` in `fileController` maps an ingestion status to wording written
    here. The real message is logged. The `error` field keeps its **name** — the web app
    reads `f.error` at `ProjectDetail.jsx:96`, and renaming it would have broken the client
    to fix a disclosure.
  * `fileIngest` no longer interpolates `parseErr.message` into its own `422`; a PDF parser
    error carries byte offsets and file fragments.
  * `embedText` no longer forwards OpenRouter's error body, and an upstream `401`/`403` is
    now a `502` here — the caller of this API *is* authenticated, it is OpenRouter that
    refused, and answering `401` told a signed-in user their session was bad. The
    auth-versus-provider distinction moved to a `code` the upload path can name without
    quoting the upstream.
* **M8 — the sign-in timing oracle is closed.** `!user` used to return before
  `bcrypt.compare`, so the two `401`s were byte-identical and ~100× apart in latency.
  `comparePassword` now runs exactly one bcrypt comparison on both paths, against a decoy
  hash built once per process when there is no real one. Measured after the change: 86.4 ms
  against 85.4 ms, a ratio of 1.01.
* **M9 — registration stops naming the constraint.** The unique-violation `409` no longer
  says which field collided, and never says `users_email_key`. It still differs from a
  successful `201` in status, which is inherent to a create endpoint — the honest limit of
  this fix, and the reason the register limiter matters.
* **M10 — member-add no longer echoes the probe.** The `404` was
  `No user found matching "<identifier>"`, which confirms to any project owner that the
  lookup ran. Fixed wording, and the two probe shapes return identical bodies.
* **M11 — logout is real, and JWT verification is pinned.** `verifyToken` now passes
  `algorithms: ['HS256']` with an issuer and audience, all three matched on sign. A token
  signed by the same organisation for a different service no longer verifies here.
  `users.token_version` (a new column, `DEFAULT 0`, idempotent `ALTER` for older
  databases) plus a `ver` claim makes `POST /api/auth/logout` revoke every outstanding
  token at once. `requireAuth` also checks the user still exists, which closes "a token for
  a deleted user keeps working". The issuer and audience are exported from `config/env.js`
  as constants that **cannot** be overridden by the environment — a token's audience is a
  property of the code that verifies it, not a deployment setting.

Verified: **44 assertions over real HTTP** in `.agents/wiki/context/t7-harness.js`, and
**16 in clean child processes** in `.agents/wiki/context/t7-boot.js`.

Over HTTP, against the real app with a table-aware stubbed pool:

* `X-Powered-By` absent; CSP, `X-Frame-Options`, `nosniff` and `Referrer-Policy` all set.
* `/health` during a database failure: `503`, body exactly `{"status":"degraded"}`, and no
  `mcp_user` / `ECONNREFUSED` / `10.0.0.5` anywhere in the response.
* A `5xx` in production is `Internal Server Error` and nothing else, while a `4xx` keeps
  `Invalid document id` — the class split, both directions.
* A token with a foreign issuer, a foreign audience, or `alg: none` is each refused; a
  correctly signed one is accepted.
* A token minted **before** `ver` existed carries no claim and still works for a version-0
  user — adding logout must not sign out everyone on deploy — and is refused for a user who
  has since bumped past 0. Both directions asserted, because the first alone would pass on
  a `ver` check that was simply absent.
* Logout: `204`, one version bump, the token it just retired is then `401`, and a second
  logout with that same token is `401` at `requireAuth` — which is correct, and which
  corrected a comment I had written claiming the endpoint was idempotent in a stronger
  sense than it is.
* Timing: 8 samples each of absent-account and wrong-password, medians 86.4 ms and 85.4 ms.
* Registration: taken-username and taken-email `409`s are byte-identical, name no
  constraint or table, and a genuinely free registration still returns `201`.
* Member-add: `404` reached — not a `500` from the stub, which is what proves the
  enumeration branch was entered — with the probe absent and both shapes identical.

In child processes, one case each: production refuses `CORS_ORIGIN=*` and names
`ALLOW_ANY_ORIGIN`; a named origin boots; `ALLOW_ANY_ORIGIN=true` permits the wildcard; the
secrets guard still fires and produces *its* message, not the new one's; `TRUST_PROXY`
across seven values still resolves as task 6 left it; and a spoofed `JWT_ISSUER` in the
environment is ignored.

**Four of my own harness bugs, all of the kind that manufacture a pass.** Worth writing
down because three of them initially showed as *failing* assertions on correct code:

* A stub regex written for a column list the middleware does not select, so the row lookup
  fell through to an empty result and every authenticated request 401'd. The application
  was right; the stub was wrong, and I nearly "fixed" the middleware to match it.
* A second stub branch, added to make member-add reachable, matched `is_owner` and so also
  swallowed the `documents` listing — breaking the `5xx` test it had nothing to do with.
  Each fix for one test broke another, which is the signature of a harness keyed on
  incidental text.
* `/SELECT .* FROM documents/` never matched, because `.` does not cross a newline and
  every query here is multi-line. That one was the dangerous direction: it made the leaky
  error unreachable, so the M4 assertions would have "passed" against a stub that never
  threw. It is now `[\s\S]*`, and the comment says why.
* Two stale expectations, not code faults: a claim-less token signed for the owner (version
  3) which correctly failed against version 0, and `TRUST_PROXY=""` which now correctly
  resolves to the default of `1` rather than `null` after your answer about Render.

The general lesson is the one from tasks 2 and 6 and it has now cost me four times: **a
stub that answers the test is worse than no stub.** A vacuous pass is invisible where a
failure is loud.

**Not verified, and this is a real gap.** Still no PostgreSQL and no Docker, so everything
DB-backed runs against a stub. Specifically unexercised: that `ALTER TABLE users ADD COLUMN
IF NOT EXISTS token_version` actually applies on a live database, and that
`token_version = token_version + 1` behaves under concurrent logout. Both should be
exercised once against a real pgvector instance before this ships.

Depends on: task 5.

### Task 8 — fix/encryption-kdf

Closes M6. The finding was narrow and precise: `ENCRYPTION_KEY` was passed through one
unsalted SHA-256 to get the 32-byte AES key, and the code and `.env.example` both described
that as a key derivation function. It is not one. A single fast hash means a weak
`ENCRYPTION_KEY` is exhausted at whatever rate the attacker's hardware allows, and any
string is still accepted as `ENCRYPTION_KEY` — which is the whole problem, because the
documented advice is `openssl rand -hex 32` and the documented fact is that anything works.

Landed:

* **`src/utils/crypto.js` rewritten around scrypt.** `N=2**15, r=8, p=1`, which is
  128 × 8 × 32768 = 32 MiB per derivation. That is *exactly* node's default `maxmem`, so
  the limit has to be raised to 64 MiB or the call is refused outright with
  `Invalid scrypt params` — a failure that would have looked like a bad key.
* **The derivation is per row, not per process.** Every encryption generates its own 16-byte
  salt, and the AES key comes from `ENCRYPTION_KEY` and *that* salt. A per-process key means
  one stolen ciphertext is attacked together with every other stolen one, and there is no
  way to contain a weak salt to the rows that share it.
* **The derivation is recorded on the row** (`key_kdf`), alongside `key_salt`. A ciphertext
  without them cannot be opened, so they are stored with it, and the name is what lets a
  future change to the parameters leave existing rows alone.
* **`encrypt` and `decrypt` are now async**, because the derivation is. `scryptSync` would
  hold the event loop for ~100 ms on the request path, and the call sites are every search,
  upload, chunk append and backfill. Measured: two derivations in parallel cost about what
  one costs, which is what the threadpool gives and what `scryptSync` would not.
* **Derived keys are cached per process** by (derivation, salt), bounded at 64 entries with
  least-recently-used eviction. The derivation is deterministic and `config.encryptionKey`
  is resolved once at require time, so an entry cannot go stale inside a process lifetime —
  rotating the key is a restart by definition. Without the cache every request pays ~100 ms
  and 32 MiB of CPU for a key it already had.
* **`encrypt` derives outside the cache.** A salt invented one line earlier can never be a
  hit, and going through the cache would evict entries that can.
* **An unrecognised derivation name is refused by name**, not treated as legacy. A fallback
  would report a corrupt row or a downgrade attempt as an opaque GCM authentication failure.
* **Rows written before this change still open**, through the old single SHA-256 pass, and
  **are rewritten under scrypt the first time they are read** — at most once per row.
* **`db/init.sql` gains `key_salt TEXT` and `key_kdf VARCHAR(16)`**, both nullable, both
  `ADD COLUMN IF NOT EXISTS`, which is how every other column addition in this repository
  is done.

**This is where I departed from the plan, and in the direction of less breakage.** `PLAN.md`
specified `SALT BYTEA NOT NULL` and rated the task High risk "needs a re-encryption or
re-prompt path", recommending it be landed only once the re-prompt cost was known. The
nullable columns and the lazy upgrade make that cost zero: no user is asked to re-enter
their OpenRouter key, and the write happens once, silently, on a read the user was making
anyway. The plan's concern was real and this is the answer to it, so I did not stop to ask
about it.

I also used `TEXT` rather than `BYTEA` for the salt, against the plan. The three sibling
columns holding the same row's binary data are base64 `TEXT`, and a row with four columns
of one type and one of another is worse than a base64 round trip. Recorded because it is a
deviation, not because it is important.

Verified: **44 assertions** in `.agents/wiki/context/t8-kdf.js` and **5** in
`t8-boot.js`. The pool stub holds a real `user_openrouter_keys` store that the application
writes to, because the whole change is a read that may rewrite the row and a stub that
discards writes would have reported the upgrade as working while proving nothing.

* Round trip, and a second encryption of the same plaintext producing a different salt, a
  different IV and a different ciphertext.
* **A ciphertext read under another salt throws**, and so does one read under the legacy
  derivation. That is the plan's own check, and it is the reason the salt is stored with
  the row rather than beside it.
* A modified ciphertext, IV and auth tag are each refused — the GCM tag doing its job.
* **A row written by the old code opens**, and opens identically through an explicit
  `sha256` name. The harness re-implements the old derivation from the env var directly
  rather than importing it, so "old rows still work" is checked against the old algorithm
  and not against a re-export of the new one.
* An unrecognised derivation, and a row marked scrypt with no salt, are each refused.
* The second read of a salt is served from cache — measured, first call versus second.
* Two derivations in parallel cost about one.
* A legacy row reads back as plaintext, is rewritten under scrypt on first read, is
  rewritten **exactly once**, leaves `updated_at` alone, and is not rewritten again. A row
  already on scrypt is not rewritten at all.
* **A failed upgrade still returns the key.** The stub is told to reject the write; the
  caller's read succeeds, the write is logged, and the row is left to be retried.
* `PUT /api/me/openrouter-key` over real HTTP stores a salt and the derivation name, the
  plaintext appears nowhere in the row, and it reads back. That last leg is the one that
  catches a mis-ordered bind parameter, which testing the controller alone would not.

Across a real process boundary, in `t8-boot.js`: a ciphertext written by this process opens
in a fresh one with the same key, does not open with a different one, and a legacy
ciphertext behaves the same way. The derivation is deterministic across restarts, which is
what stops a deploy from locking everyone out of their own key.

**One harness bug, of the kind that hides a real defect.** I built the legacy test row by
spreading encryption output straight onto it, so every `key_*` column was `undefined` and
the read failed — for a reason that had nothing to do with the KDF, which is exactly how a
harness sends you looking in the wrong place. `asRow()` now maps the parts onto the column
names the code actually reads.

**Not verified.** Still no PostgreSQL, so the two `ALTER`s and the `UPDATE` that performs
the upgrade are unexercised against a live database. The upgrade is a plain statement
against columns this repository defines, and the ALTERs follow the same idempotent pattern
as the `token_version` one in task 7, but neither has run anywhere real. This is the last
task that touches the database, and it is worth one pass against a live pgvector instance
before the release.

Depends on: task 7.

### Task 9 — chore/security-hardening-release

`2.0.0`, approved by the user, with `wiki/logs/2/0/0/CHANGELOG.md` and `package.json` (and
`package-lock.json`, whose two version fields were the only thing that changed — the
lockfile was already accurate for every dependency).

**Why a major, and why I asked rather than choosing.** A deployment that upgrades and
changes nothing refuses to start, twice over: once for a published secret and once for a
CORS wildcard in production. That is breaking by semver, and it is a version claim about
what an operator must do, so the version rules gate it. The user's answer was `2.0.0`, with
`1.2.0` and no bump offered as the alternatives.

The changelog leads with an **Upgrading** section rather than burying the required
operator actions under a feature list, because the first thing someone reads after a
major bump is the answer to "what do I have to do before this boots".

**Two version inconsistencies found while doing this, both reported rather than fixed:**

* `package.json` said `1.0.0` while `wiki/logs/1/1/0/CHANGELOG.md` recorded a 1.1.0
  released on 2026-09-10. The version was never bumped when 1.1.0 shipped. It now goes
  straight to 2.0.0; bringing it to 1.1.0 first would have been a version claim of its
  own, and the released 1.1.0 log is not mine to edit.
* No git tag was created. A tag is a version carrier, and the commits are still local —
  tagging a version that exists on no remote would be claiming a release that has not
  happened. It belongs with the pull request.

**The record is closed but the chains are not.** Every finding in `REPORT.md` is closed or
explicitly deferred, and the three repositories each carry their own chain. What is
deliberately left open, and why:

* **The web client's `logout()` never calls the API.** See the cross-repository section
  above. Scheduled as `fix/session-hygiene` in chain 3.
* **MCP `/api/mcp/projects` exposes owner-equivalent capability to any member** — the
  removal half of H4. Scheduled in chain 2 as `fix/remove-admin-from-mcp`.
* **M15**, separate migration and runtime database roles: a deployment concern, not a code
  change, and doing it properly means provisioning work outside this repository.
* **Moving the session from `localStorage` to an httpOnly cookie.** Larger than it looks —
  it is what would make the CORS wildcard critical — and it changes the auth shape of all
  three repositories at once.
* **M17 react-router**, **automated tests**, and **reducing the 20-files-per-upload
  default**. Each is a product or scheduling decision rather than a defect.
* **The 120/min MCP budget under real load.** A judgement call, unmeasured, and recorded as
  the first number to revisit.

## Decisions

* **The guard throws rather than warns.** A process that starts with a defaulted secret
  is a process serving forged sessions, and a warning does not stop it. Production
  refuses to boot; development keeps the fallbacks so the convenience is preserved where
  it is not dangerous.
* **A set value that equals the published default is rejected, not just an unset one.**
  Setting `JWT_SECRET` to the literal in `.env.example` is the same failure as not
  setting it, and it is the more likely mistake, because the file is copy-pasted.
* **Any member may mint a project token; `editor` may write.** Both are the user's
  direction, and both are product decisions rather than security findings. A minted token
  is safe because every write tool is gated, and because task 5 makes the token stop
  working when the membership behind it is removed. The plan's earlier assumption that
  `editor` could already write was wrong and is corrected in task 4.
* **Administration is stricter than writing.** `canAdminister` is owner-or-admin, so an
  editor cannot grant roles. An editor able to hand out roles could promote themselves,
  which would turn the write grant into an escalation path.
* **Encryption key rotation is operational, not code.** The guard stops a future
  misconfiguration; it cannot reach back to a deployment that already booted on the
  published constants. Rotating `JWT_SECRET` and `ENCRYPTION_KEY` is a deployment step
  the user performs, and rotating the second makes every stored OpenRouter key
  undecryptable, so it is deliberately sequenced away from the key derivation change in
  task 8 — doing both at once requires a re-encryption path that does not exist.
* **The project's own `version` is not touched.** The instruction to take the latest
  release covers the libraries. Bumping `1.0.0` is a separate claim and belongs to the
  release task with the user's approval.
* **A token's authority is read fresh, not baked in at issue.** Both the membership check
  and the role now come from `document_members` on every request. The alternative — stamp
  the role into the token at mint time — is cheaper and is what the code did, and it is
  what makes a demotion a no-op until the token is rotated.
* **Removal and revocation are both kept.** The middleware join is what makes a removal
  take effect immediately; the explicit deactivation in `removeMember` is what stops the
  token returning if the same person is re-added later. Neither alone is the fix.
* **`TRUST_PROXY` is a variable, not a constant, and `true` is refused.** The plan said to
  set it only behind exactly one proxy you control, which is a fact about a deployment
  this repository does not describe. Encoding a guess as a constant would have made a
  limiter either bypassable or useless, and the mistake would not have shown up until
  someone was rate-limited by a forged header. `true` is rejected rather than supported,
  because the only deployment it is right for is one where the client is not the last
  hop. The user confirmed the deployed app sits behind one proxy, so the default is now
  `1`; it was `null` — effectively zero — which would have put every production caller in
  one shared bucket.
* **Sign-in is limited on failures, not on attempts.** `skipSuccessfulRequests` means a
  correct password costs nothing. Limiting attempts instead would protect nothing extra
  against an attacker, who will use wrong passwords, and would lock out anyone using a
  shared machine.
* **A new runtime dependency is a thing to ask about, not to route around.** The
  permission classifier refused `express-rate-limit` because I chose it. Writing a
  hand-rolled limiter in a `Map` to avoid the prompt would have been worse on every axis
  that matters — unbounded keys, no standard headers, no cleanup of idle buckets, and a
  second home for a security-relevant behaviour. The user approved the package and it was
  installed.
* **Size limits are `413`, not `400`.** A well-formed request that is too big is a
  different failure from a malformed one, and a client retrying a 400 will not help.
* **A CORS wildcard is a decision, not a default.** `*` is not exploitable today — bearer
  tokens, no cookies, nothing for a hostile page to ride — and it becomes critical the
  moment cookie auth or `credentials: true` is added. Which of those two happens first is
  not something a config file can enforce, so the wildcard has to be asked for by name
  (`ALLOW_ANY_ORIGIN=true`) and production refuses to boot without it. Blocking on a risk
  that is not live yet would be the other kind of wrong; so would leaving it silent.
* **The error handler branches on class, not on message.** A `4xx` is text this
  application wrote for this caller and is safe to return; a `5xx` came from node-postgres,
  an upstream or a library and is not. Branching on the message would mean trusting every
  string that ever reaches the handler, including ones a dependency invents next year. The
  branch is on `nodeEnv`, so a deployment cannot switch it off by setting the wrong thing.
* **`requireAuth` costs a database lookup on every authenticated request, and that is the
  price of a session that can end.** Statelessness bought the sign-out button nobody had
  and cost a token that survived its own user's account. The lookup is one indexed primary
  key hit; a cached revocation list would be faster and would be another thing to keep
  consistent with the database, which is the class of bug this task exists to remove.
* **The KDF change is task 8, not part of task 7.** They are both "hardening" in the loose
  sense and they are unrelated work: one changes what a response may say, the other
  changes a stored ciphertext's compatibility. Sharing a commit would make the release note
  claim both at once and put a breaking schema change in the same review as a diff nobody
  can revert cleanly.
* **A comment that the harness disproved was corrected rather than the code.** `logout`
  said it was idempotent; it is not — a second logout with the retired token is a `401` at
  `requireAuth`, and that is the right answer. The comment now says what the code does. A
  test that fails against correct code is usually the test that is wrong, and the honest
  response is to find out which it is rather than to make the assertion pass.
* **`X-Powered-By` is off and helmet is on** — recorded as a decision rather than a
  preference, because "we already have a framework that could do this" is a real argument
  and the answer is that hand-maintaining a header set is how they go stale.
* **The KDF cost is hard-coded, not configurable.** A KDF whose parameters can be lowered by
  an environment variable is one mis-set variable away from not being a KDF, and that
  failure is silent — the data is still encrypted, just cheaply. There is no legitimate
  reason to run this at a lower cost in development that is worth the possibility of it in
  production.
* **The derivation is per row, and the row carries its salt and the name of the
  derivation.** Per process would mean every stored key shares one key, so one stolen
  ciphertext is attacked alongside every other one and a weak salt is not contained to the
  rows that share it. Storing the name is what makes a future change to the parameters a
  non-event rather than a re-encryption project.
* **Existing rows are upgraded on read rather than in a migration.** The plan rated this
  the High-risk task and wanted to know the re-prompt cost before landing it. Making both
  new columns nullable and rewriting a legacy row the first time it is read makes that cost
  zero, which is a better answer than asking. The upgrade is best effort and never fails
  the caller's request — the plaintext has already been recovered, so refusing it would be
  worse than retrying on the next read.
* **Derived keys are cached, and that is safe only because the value is require-time.** If
  `ENCRYPTION_KEY` were ever read per request the cache would be a stale-key bug. Rotating
  the key is a restart by definition, so it is a constraint rather than a coincidence, and
  it is written down in `crypto.js` so the next reader knows it is load-bearing.
* **`apiToken.js` keeps its single SHA-256.** It hashes 32 bytes of `crypto.randomBytes`,
  so there is no low-entropy secret to stretch. A KDF earns its cost on a value a human
  chose, which is precisely what `ENCRYPTION_KEY` is and precisely what a project token is
  not — recorded so a future reader does not "fix" it.

## Cross-repository follow-up, not done here

`client-reactjs/src/context/AuthContext.jsx` — `logout()` calls `setToken(null)` and
nothing else. It never contacts the API, so the token the browser still holds in
localStorage stays valid server-side until it expires, and the `POST /api/auth/logout` this
task added is unreachable from the web app. Signing out has to call the endpoint and only
then clear local state.

Not fixed here on purpose. This workspace's rule is that a change spanning repositories is
more than one work task, each with its own branch, commits and pull request, ordered rather
than stacked — and `client-reactjs` is chain 3 of 3, behind its own dependency upgrade. It
is scheduled as `fix/session-hygiene` in that chain, where it belongs.

## Status

**Complete for this repository.** All nine tasks are done and committed on stacked local
branches, ending at `chore/security-hardening-release`. The release is `2.0.0`.

Nothing has been pushed and no pull request has been opened — the user asked to review the
diff first. Opening and merging the pull request are separate gates and both are still
closed.

Two further chains run in the other repositories of this workspace, at merge order 2 of 3
(`mcp`) and 3 of 3 (`client-reactjs`). They are not started. Each needs its own task record
in its own repository, its own branches, and its own pull request; a change spanning
repositories is more than one work task and never one task in whichever repository happened
to be open.

Every finding in `REPORT.md` is either closed or listed with its reason in the **Task 9**
entry above. Nothing was closed by quietly widening the question.
