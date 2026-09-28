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
running the server against a pgvector database and exercising the affected route.

## Tasks

| # | Title | Scope | Repository | Branch | PR |
|---|---|---|---|---|---|
| 1 | The record | The confirmed list and its decisions | server-expressjs | `chore/security-hardening-plan` |  |
| 2 | Refuse to boot on a missing or defaulted secret | The guard, `.env.example` | server-expressjs | `fix/fail-closed-secrets` |  |
| 3 | Dependencies to current, Express 5 migration | `package.json`, the middleware and routes it breaks | server-expressjs | `build/dependency-upgrade` |  |
| 4 | Close the `viewer` write escalation | `addKnowledge` authorization, role-aware token issuance | server-expressjs | `fix/project-authorization` |  |
| 5 | Bind API tokens to live membership, expire them | `apiToken` middleware, issuance, removal | server-expressjs | `fix/api-token-lifecycle` |  |
| 6 | Bound the work a request can cause | Rate limits, authorization order, upload limits, timeouts | server-expressjs | `fix/request-limits` |  |
| 7 | Stop the information the error paths give away | `helmet`, health, error handler, timing, enumeration | server-expressjs | `fix/error-disclosure` |  |
| 8 | Derive the key properly | scrypt and a persisted per-row salt | server-expressjs | `fix/encryption-kdf` |  |
| 9 | Release | Version, changelog, this record closed | server-expressjs | `chore/security-hardening-release` |  |

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

## Decisions

* **The guard throws rather than warns.** A process that starts with a defaulted secret
  is a process serving forged sessions, and a warning does not stop it. Production
  refuses to boot; development keeps the fallbacks so the convenience is preserved where
  it is not dangerous.
* **A set value that equals the published default is rejected, not just an unset one.**
  Setting `JWT_SECRET` to the literal in `.env.example` is the same failure as not
  setting it, and it is the more likely mistake, because the file is copy-pasted.
* **`editor` is assumed able to write.** The role check on knowledge writes gates at
  admin today and this work keeps that bar. Whether `editor` should also be able to mint
  a project token is a product decision, not a security one, and is asked before that
  task rather than assumed.
* **Encryption key rotation is operational, not code.** The guard stops a future
  misconfiguration; it cannot reach back to a deployment that already booted on the
  published constants. Rotating `JWT_SECRET` and `ENCRYPTION_KEY` is a deployment step
  the user performs, and rotating the second makes every stored OpenRouter key
  undecryptable, so it is deliberately sequenced away from the key derivation change in
  task 8 — doing both at once requires a re-encryption path that does not exist.
* **The project's own `version` is not touched.** The instruction to take the latest
  release covers the libraries. Bumping `1.0.0` is a separate claim and belongs to the
  release task with the user's approval.

## Status

In progress. Tasks 1 and 2 of 9 complete.
