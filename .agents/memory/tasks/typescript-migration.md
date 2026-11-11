---
name: memory-tasks-typescript-migration
description: Record of migrating the mcp-rag-server backend from CommonJS JavaScript to strict TypeScript on the latest dependencies, with the plan confirmed before the work began.
---

# Task: TypeScript migration

status: in progress

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
| 1 | Task record | This file and its index row | `plan/typescript-migration` | |
| 2 | Dependencies | Latest dependencies, TypeScript tooling, nodemon replaced by `tsx watch`, audit fix | `chore/dependencies` | |
| 3 | TypeScript conversion | `tsconfig.json`, every `src/*.js` to typed `.ts`, `package.json` entry and scripts, Dockerfile build stage | `refactor/typescript` | |
| 4 | Test suite | `npm test`: unit tests through tsx, then the four harnesses against `dist/` | `test/typescript-suite` | |
| 5 | Documentation | `README.md`, `wiki/`, `.agents/wiki/` and state memory brought in line | `docs/typescript` | |
| 6 | Release | Version, changelog, log index rows, closing entry | `release/{version}` | |

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
