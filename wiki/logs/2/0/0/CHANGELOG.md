# 2.0.0

Released 2026-09-28.

A production deployment that upgraded from 1.0.0 and changed nothing will refuse to start.
That is the point of the release rather than a side effect of it: the shipped fallback
secrets are published in this repository, so a process running on them was offering
forgeable sessions and readable stored API keys. Alongside that, every request is now
bounded, project tokens are bound to live membership, the error paths no longer describe
the system to whoever triggered them, and a session can finally be ended.

## Upgrading

Four things have to be true in a production environment before this version will boot. The
first two are refusals, not warnings.

* **`JWT_SECRET`, `ENCRYPTION_KEY` and `DATABASE_URL` must be set to real values.** A
  missing one is refused, and so is one still holding the literal published in
  `.env.example`, because copying that file and leaving a line alone is the likelier
  mistake and produces the identical failure. Generate each with `openssl rand -hex 32`.
* **`CORS_ORIGIN` must name the frontend origin**, or be `*` together with an explicit
  `ALLOW_ANY_ORIGIN=true`. The default is now the Vite dev server's origin rather than a
  wildcard, and a wildcard in production is refused.
* **`TRUST_PROXY` should stay at its new default of `1`** if the app is behind Render,
  which terminates TLS and forwards, so there is exactly one hop that overwrites
  `X-Forwarded-For`. Set it to `0`, or leave it empty, for `npm run dev` against the app
  directly. `true` is refused outright: it trusts the last hop, and the last hop is the
  client.
* **Rotating `JWT_SECRET` and `ENCRYPTION_KEY` is a separate, deliberate step.** The guard
  stops a future misconfiguration; it cannot reach back into a deployment that already
  booted on the published constants. Rotating the first signs everyone out. Rotating the
  second makes every stored OpenRouter key undecryptable, with no re-encryption path, so
  every user has to re-enter theirs. Neither loses data and both are user-visible, so do
  them on their own rather than as part of this upgrade.

Two schema changes are applied on boot and need no migration step: `users.token_version`
and `user_openrouter_keys.key_salt` / `key_kdf`. Existing databases pick them up on the
next start.

Nothing in this release requires a user to re-enter an OpenRouter key. A row encrypted
before 2.0.0 still opens, and is rewritten under the new derivation the first time it is
read.

**On the version numbers.** `package.json` read `1.0.0` from the first commit to this one —
the multi-model embedding work described in [1.1.0](../1/1/0/CHANGELOG.md) shipped in the
code and was logged here, but the manifest was never advanced and no tag was ever cut, so
1.1.0 is documented rather than released. An operator therefore reads this upgrade as
1.0.0 to 2.0.0. Nothing is missing between them, and the 1.1.0 log is left as written: it
records what the code did, and rewriting a dated log to match a manifest would be a
version claim of its own.

## Security

* **A production process refuses to start on a published secret.** `JWT_SECRET`,
  `ENCRYPTION_KEY` and `DATABASE_URL` are checked as the config is built, before the
  process can listen, and the failure names which value was missing and which was still
  set to its default. Development keeps the fallbacks, so the convenience is preserved
  where it is not dangerous.
* **A project API token is bound to live membership, and expires.** `requireApiToken`
  resolved the principal from `api_tokens` alone, so removing a collaborator left their
  token working indefinitely — and `expires_at` was in the schema and honoured by the
  guard, but nothing ever wrote it, so every token took the `NULL` default and the expiry
  clause was always satisfied. The middleware now joins `document_members` and refuses a
  token whose user no longer owns or belongs to the project, reads the role from that same
  row per request so a demotion takes effect immediately, and stamps a 90-day expiry at
  issue and at every rotation.
* **The role hierarchy is defined once.** `src/utils/roles.js` is the only place the
  ranking exists, and both questions the application asks go through it. Administration is
  deliberately stricter than writing, so an editor cannot grant roles — an editor able to
  hand out roles could promote themselves.
* **Membership is managed by the owner and by admins, on both paths.** The web path asked
  whether the caller was the owner and nothing else, so an `admin` could add and remove
  members through an assistant — where `canAdminister` is the test — but not through the
  browser. Both paths now ask `canAdminister`, and the `canManage` flag the web app reads
  is that same answer rather than a second opinion about ownership, so the controls appear
  for an admin with no change to the client. An `editor` is still refused on both.
* **Logout is real.** `POST /api/auth/logout` bumps the caller's `token_version`; a token
  carries the version it was signed with, so every outstanding token is retired at once. A
  stateless JWT cannot otherwise be cancelled, and the old remedy — rotating the global
  signing secret — signs out everyone. `requireAuth` also checks the user still exists, so
  a token for a deleted account stops working. The cost is one indexed primary key lookup
  per authenticated request, which is what buys a session that can end.
* **JWT verification is pinned** to `HS256` with an expected issuer and audience, all
  three matched on sign. Left unpinned, a token chooses its own algorithm, and a token
  signed by the same organisation for a different service verifies here. The issuer and
  audience are exported as constants the environment cannot override.
* **The error paths stopped describing the system.** A database failure on the
  unauthenticated `/health` endpoint could read `password authentication failed for user
  "mcp_user"`, confirming the credentials published in this repository are live. The
  central handler returned `err.message` for every failure, so a duplicate key could name
  `uq_api_tokens_user_project` — a free map of the schema. A `4xx` now keeps text written
  for that caller; a `5xx` in production is `Internal Server Error` and the detail goes to
  the log. Three `4xx` paths carried text from elsewhere and were reduced separately: the
  upload `422`, the PDF parser message, and OpenRouter's error body.
* **Sign-in is no longer an enumeration oracle by timing.** The handler returned before
  `bcrypt.compare` for an account that did not exist, so the two `401`s were byte-identical
  and about a hundredfold apart in latency. Both paths now do exactly one bcrypt comparison
  against the same cost factor, using a decoy hash when there is no real one: measured 1.01×
  apart. Registration's `409` no longer names the constraint or the colliding field, and
  member-add's `404` no longer echoes the identifier back.
* **`X-Powered-By` is off and security headers are on**, via `helmet`. A framework and
  version handed to anyone is a free input to matching a CVE against it.
* **CORS is a named allow list.** `*` is not currently exploitable — the API uses bearer
  tokens, so there is no ambient credential for a hostile page to ride — and it becomes
  critical the moment cookie auth or `credentials: true` is added. Which of those happens
  first is not something a config file can enforce, so the wildcard now has to be asked for
  by name.

## Changed

* **Every dependency is at its current release, majors included.** Express 4 to 5, which
  changes the router's path parsing and the behaviour of `*` wildcards, and the middleware
  it breaks with them. `express-rate-limit` v8.7.0 and `helmet` v8.3.0 are new runtime
  dependencies. `npm audit` reports 0 vulnerabilities.
* **Every request is bounded, by size and by frequency.** Uploads were authorized after
  `multer` had already buffered them, so a caller with no access to a project could make
  the process hold up to 200 MB before being refused, and the same request could then spend
  the uploader's OpenRouter credits across thousands of sequential embedding calls.
  Authorization now runs ahead of the parser; the multipart body is bounded by shape as
  well as size; a limit that is hit returns `413` rather than being flattened to `400`;
  chunks per file are capped at 2000, checked before the embedding loop; and the two
  unbounded waits are bounded at 30 s upstream and 15 s parsing.
* **Rate limits exist.** 60/min on `/api` generally, 10 per 15 min on sign-in keyed on
  address *and* account, 10 per 15 min on registration, 120/min on the MCP surface, and
  nothing on the liveness probes. Sign-in counts failures rather than attempts, so a
  correct password spends no budget and nobody locks themselves out on a shared machine.
* **`TRUST_PROXY` is a variable rather than a constant.** Every rate limit in the
  application rests on `req.ip` being the client, and only the deployment knows how many
  proxies there are. The default is now `1`; it was effectively zero, which put every
  production caller in one shared bucket.
* **Stored API keys are encrypted under a per-row derived key.** `ENCRYPTION_KEY` was
  passed through a single unsalted SHA-256, and the code described that as a key derivation
  function. Each row now carries its own 16-byte salt and the AES key comes from scrypt
  (`N=2**15`, `r=8`, `p=1`). Any string is still accepted as `ENCRYPTION_KEY`, and the KDF is
  what makes that acceptable rather than a rule nobody follows. Derived keys are cached per
  process, and the derivation is asynchronous, so reading a key does not hold the event loop.
* **The Dockerfile builds on `node:22-slim`**, because the previous `node:20` tag reached
  end of life in April 2026 and no longer receives security fixes, and installs with
  `npm ci --omit=dev` rather than `npm install`, so the image contains exactly the tree the
  lockfile pins and fails the build if the two disagree.

## Added

* `POST /api/auth/logout`, JWT-protected, retiring every outstanding token for the caller.
* `users.token_version` and the `ver` claim it is checked against.
* `user_openrouter_keys.key_salt` and `key_kdf`, carrying the derivation each ciphertext
  was written with. A row with neither predates this release, opens through the old
  derivation, and is rewritten under scrypt on first read.
* `GET /api/documents/:id/token` is available to any member including a `viewer`, by
  decision. A minted token is safe because every write tool is gated, and because removal
  from a project now stops it working.

## Known limitations

* The web client does not yet call `POST /api/auth/logout`. Its `logout()` clears local
  state only, so a token the browser still holds stays valid until it expires. The
  revocation is correct on the server and unreachable from the app; it is fixed in the
  `client-reactjs` chain, not here.
* The project token issuance path and the rate limits have not been exercised under
  concurrent load. In particular the 120/min MCP budget is a judgement call, and it is the
  first number to revisit if legitimate assistants are being cut off.
* `user_openrouter_keys` is written by the same role that owns the application, so
  separating migration and runtime database roles remains outstanding.
