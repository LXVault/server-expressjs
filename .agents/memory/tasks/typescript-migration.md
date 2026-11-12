---
name: memory-tasks-typescript-migration
description: Record of migrating the mcp-rag-server backend from CommonJS JavaScript to strict TypeScript on the latest dependencies, with the plan confirmed before the work began.
---

# Task: TypeScript migration

status: done

**Goal.** The backend is about 4,000 lines of untyped CommonJS with no build step. Move it
to strict TypeScript on the latest release of every dependency, with a clean `npm audit`,
without changing what the API does.

**Objective.** `npm run build` emits `dist/` with zero compiler errors. `npm test` passes,
including the four stub-DB harnesses under `.agents/wiki/context/`, which passed 129 of 129
checks against the JavaScript before any change. `npm audit` reports no vulnerabilities.

**Detail.** Routes, SQL, `db/init.sql`, both authentication paths, the embedding
invariants and every error message stay as they are. The source is written with ES
`import` syntax and compiled to CommonJS (`"module": "NodeNext"` under
`"type": "commonjs"`). The harnesses stub the pg pool through `require.cache`, which
only works against CommonJS output, so keeping it is what lets them prove the behaviour
did not move. The task list was approved by the owner on 2026-11-12, before any of it
was built.

## Plan

| # | Title | Scope | Branch | PR |
|---|---|---|---|---|
| 1 | Task record | This file and its index row | `plan/typescript-migration` | #15 |
| 2 | Dependencies | Latest dependencies, TypeScript tooling, nodemon replaced by `tsx watch`, audit fix | `chore/dependencies` | #16 |
| 3 | TypeScript conversion | `tsconfig.json`, every `src/*.js` to typed `.ts`, `package.json` entry and scripts, Dockerfile build stage | `refactor/typescript` | #17 |
| 4 | Test suite | `npm test`: unit tests through tsx, then the four harnesses against `dist/` | `test/typescript-suite` | #18 |
| 5 | Documentation | `README.md`, `wiki/`, `.agents/wiki/` and state memory brought in line | `docs/typescript` | #19 |
| 6 | Release | Version, changelog, log index rows, closing entry | `release/3.0.0` | #20 |

Each branch stacks on the one before it. One pull request per branch.

## 2026-11-12

### Task 1 — plan/typescript-migration

Created this record and its row in `.agents/index/memory-index.md`. Nothing else has
landed. Baseline taken before any change: the four harnesses pass 129 of 129 against the
JavaScript (`t7-harness` 64, `t7-boot` 16, `t8-kdf` 44, `t8-boot` 5).

### Task 2 — chore/dependencies

Every runtime dependency is on its latest release: `dotenv` 18.0.10, `express` 5.3.0,
`express-rate-limit` 8.7.4, `multer` 2.5.0, `pg` 8.23.1; the rest were already current.
Added as dev dependencies: `typescript` 7.0.2, `tsx` 4.23.15, `@types/node`, and
`@types/` packages for express, cors, jsonwebtoken, multer and pg. `bcryptjs` 3 and
`pdf-parse` 2 ship their own declarations, so no `@types/` package is added for either.

`nodemon` is removed. Its `minimatch` dependency carried an advisory with no
non-breaking fix, and `tsx watch` replaces it from task 3. Until then `npm run dev` is
`node --watch src/index.js`. `npm audit fix` cleared `body-parser`, `ip-address` and
`qs`; `npm audit` now reports 0.

Verified: the four harnesses still pass 129 of 129 on the upgraded tree.

### Task 3 — refactor/typescript

Every file under `src/` is renamed `.js` to `.ts` with `git mv` and typed under
`"strict": true`. `tsconfig.json` targets ES2022 with `NodeNext` module and resolution,
`rootDir ./src`, `outDir ./dist`. The package stays `"type": "commonjs"`, so the source
uses ES `import`/`export` and `tsc` emits CommonJS; relative imports carry `.js`.

What was added for the types, none of which changes behaviour:

* `src/types/http.ts` holds the shared shapes (`HttpError`, `MemberRole`, `AuthUser`,
  `ApiTokenContext`, `DocumentRow`, `DocumentAccess`) and `httpError()`, which builds the
  same `Error` with `status` and `code` assigned that every throw site built by hand.
* `src/types/express.d.ts` declares `req.user`, `req.apiToken` and `req.documentAccess`
  as optional. Controllers behind a guard read them with `!`.
* Query results are typed through `query<Row>()`; request bodies through a cast to a
  per-handler interface, with the existing `String()` coercions left in place.
* `env.ts` exports the config object as `default`; everything else uses named exports.

Two loading details moved and were kept equivalent. `pdf-parse` is still loaded on first
use, now through `await import()`. The router was a `require` inside `app.use`; it is a
top-level import now, which only changes when the route modules load, not what they do.
`migrate.ts` still resolves `../../db/init.sql`, which holds from `dist/config/` too.

`package.json`: `main` is `dist/index.js`; scripts are `build` (`tsc`), `typecheck`,
`start` (`node dist/index.js`) and `dev` (`tsx watch src/index.ts`). The Dockerfile gains
a build stage (`npm ci --include=dev`, then `npm run build`) and runs `dist/index.js`.

Verified: `tsc` reports zero errors, and a planted implicit `any` is rejected, so strict
is in force. `node dist/index.js` boots and answers `/`, `/health` (503 with no
database), `/api/ping` and the 401 on `/api/documents`; `tsx src/index.ts` boots too.
The four harnesses, pointed at `dist/` (committed in task 4), pass 129 of 129. The image
was not built: there is no Docker daemon in this environment.

Found, not fixed: Express 5 delivers the `*model` wildcard as an array of segments, so
`deleteModelEmbeddings` receives `["openai","text-embedding-3-small"]`,
`normalizeModelName` returns null, and `DELETE /api/documents/:id/embeddings/*model`
answers 400 for every model. This predates the migration and is left for its own change.

### Task 4 — test/typescript-suite

`npm test` now exists: `npm run build`, then `npm run typecheck` (`tsconfig.test.json`
checks `src/` and `test/` together without emitting), then `tsx --test test/*.test.ts`
on the built-in `node:test` runner.

* `test/units.test.ts` covers the pure helpers from the TypeScript source: roles,
  model-name normalization, chunking and extensions, token generation and hashing, JWT
  sign and verify, the scrypt round trip and `httpError`. It also pins the wildcard
  finding from task 3: `normalizeModelName` of an array is null.
* `test/harnesses.test.ts` runs the four harnesses as child processes against `dist/`
  and fails on a non-zero exit.

The harnesses now load `dist/` rather than `src/`, and read the config and app through
`.default`, since those two modules use a default export. They still stub the pool
through `require.cache`, which works because the output is CommonJS.

Verified: `npm test` passes 11 of 11 (7 unit, 4 harness), and the harnesses inside it
pass 129 of 129.

### Task 5 — docs/typescript

Brought every page that described the JavaScript tree in line with the TypeScript one:
`README.md` (quick start, build, start, test), `wiki/environments/setup.md` (dev through
tsx, build and start, a real Testing section), `wiki/environments/docker.md` (the build
stage, `dist/index.js`), `wiki/environments/env.md` and
`wiki/information/architecture.md` (`src/*.ts` paths, where the types live),
`.agents/wiki/context/repository-map.md` (commands, `src/types/`, `npm test` as the
regression check, three new gotchas: CommonJS output is load-bearing for the harnesses,
the two default exports, and the wildcard-array bug), and
`.agents/memory/state/repository-state.md`.

`.agents/rules/repository.md` was first left stale, because it is an instruction and the
discovery protocol says to propose rather than edit. The finding was presented and the
owner selected it ("apply") on 2026-11-12, so it landed in its own commit on this branch:
the CommonJS and `'use strict'` rule now describes TypeScript compiled to CommonJS, the two
`src/*.js` paths name the `.ts` files, and Running it describes `npm test`. `wiki/logs/` is untouched; it belongs to the release.

### Task 6 — release/3.0.0

The owner chose 3.0.0 on 2026-11-12: the HTTP API is unchanged, but every deployment's
build and start commands are not, so an operator who changes nothing breaks. `package.json`
and `package-lock.json` read `3.0.0`. Added `wiki/logs/3/0/0/CHANGELOG.md`, with an
Upgrading section that names the new build and start commands, and its row at the top of
`.agents/index/logs-index.md`. No session files exist under `.agents/memory/`, so there is
no digest to fold.

The `/` route still reports `version: '1.0.0'`, as it did in 2.0.0; it is a hard-coded
string in `src/app.ts` and changing it is a behaviour change outside this migration.
`logs-index.md` has no row for 2.0.0, which predates this work and is left as found.

Verified at this commit: `npm run build` exit 0, `npm run typecheck` exit 0, `npm test`
11 of 11, `npm audit` 0 vulnerabilities.

Pull requests opened 2026-11-12 as one stacked chain, #15 through #20, filled into the
plan table above. Nothing is merged; merging waits on the owner.
