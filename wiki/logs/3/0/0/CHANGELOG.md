# 3.0.0

Released 2026-11-12.

The backend is now strict TypeScript, compiled to `dist/`, on the latest release of every
dependency. The HTTP API is unchanged: every route, status code, response body and error
message is what 2.0.0 returned. The version is major because **how the service is built
and started has changed**, and a deployment that keeps its 2.0.0 commands will not boot.

## Upgrading

* **Build before you start.** Run `npm ci`, then `npm run build`, then `npm start`.
  `npm start` runs `node dist/index.js`. A deploy command that runs `node src/index.js`
  fails, because `src/` now holds `.ts` files.
* **On Render or any other platform with its own build step**, set the build command to
  `npm ci && npm run build` and the start command to `npm start`. The build needs the dev
  dependencies (the compiler). If the platform sets `NODE_ENV=production` while
  installing, use `npm ci --include=dev`.
* **Docker** needs nothing from you. The image gains a build stage and runs
  `node dist/index.js`.
* **Local development** keeps `npm run dev`, which now runs the TypeScript source through
  `tsx watch`. `nodemon` is gone.

No environment variable, schema or data change is involved. `db/init.sql` is untouched.

## Added

* **`npm test`.** It builds, type-checks `src/` and `test/`, then runs `node:test` suites
  through `tsx`: unit tests for the pure helpers, and the four stub-database verification
  harnesses against the compiled output. None of it needs PostgreSQL. See
  [setup.md](../../../environments/setup.md#testing).

## Changed

* **TypeScript.** Every file under `src/` is `.ts` and type-checked under `"strict": true`
  (`tsconfig.json`: ES2022, `NodeNext`, `rootDir ./src`, `outDir ./dist`). The output is
  CommonJS, as before. The types live in `src/types/`: the request context the middleware
  attaches to `req`, the shared row and error shapes, and `httpError()`.
* **Dependencies.** `dotenv` 18.0.10, `express` 5.3.0, `express-rate-limit` 8.7.4,
  `multer` 2.5.0 and `pg` 8.23.1. Added for development: `typescript` 7, `tsx`,
  `@types/node`, and `@types/` packages for express, cors, jsonwebtoken, multer and pg.
  `npm audit` reports no vulnerabilities; the `body-parser`, `ip-address`, `qs` and
  `minimatch` (through `nodemon`) advisories are gone.
* **Scripts.** `build`, `typecheck`, `start`, `dev` and `test`.

## Removed

* **`nodemon`.** `npm run dev` uses `tsx watch` instead. Nothing to do unless a script of
  your own called `nodemon` directly.

## Known issue

* `DELETE /api/documents/:id/embeddings/*model` answers `400 Invalid model name` for every
  model. Express 5 passes the `*model` wildcard as an array of path segments and the
  handler expects a string. This was already true in 2.0.0, is unchanged here, and is
  pinned by a unit test so the fix is visible when it lands.
