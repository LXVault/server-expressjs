# Local Setup

## Requirements

* Node.js 20 or newer. The container image is built on `node:22-slim`.
* PostgreSQL 14 or newer with the `pgvector` extension available. The schema runs
  `CREATE EXTENSION IF NOT EXISTS vector` on boot, so the extension must be installed on
  the server even though the database does not need it enabled beforehand.

## Steps

```
npm install
cp .env.example .env      # optional, every value has a fallback
npm run dev               # tsx watch: runs src/index.ts, reloads on change
```

The source is TypeScript and `npm run dev` runs it directly through `tsx`, with no build
step. For the compiled server, the way production runs it:

```
npm run build             # tsc: src/ -> dist/
npm start                 # node dist/index.js
```

`npm run typecheck` checks `src/` and `test/` without emitting anything.

The server listens on `PORT`, default `4000`. Every variable and its fallback:
[env.md](env.md).

## Verify

```
curl localhost:4000/health
```

A healthy server answers `{"status":"ok"}`. If it answers `503` with
`{"status":"degraded"}`, the process is running but `DATABASE_URL` is wrong or the database
is unreachable; the API still serves requests and every database backed route will error.
The reason is on the server log and nowhere else — this endpoint is unauthenticated, and a
database error message can name the user, the host and the credentials that failed.

On boot the log shows three lines worth reading:

```
[server] listening on port 4000 (development)
[db] connection OK
[migrate] schema applied (db/init.sql)
```

A missing `[migrate]` line means either `AUTO_MIGRATE=false` or the schema failed to
apply, and the error is logged immediately after.

## Database

Point `DATABASE_URL` at any PostgreSQL instance with pgvector. The schema creates itself
on first boot, so an empty database is enough:

```
createdb mcp_rag
psql mcp_rag -c 'CREATE EXTENSION IF NOT EXISTS vector'
```

The second line is optional, since the schema does it too, but running it first tells you
straight away whether the extension is installed.

## Using the API

Register, then use the returned token as a bearer token:

```
curl -X POST localhost:4000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo","email":"demo@example.com","password":"secret123"}'

curl localhost:4000/api/documents -H 'Authorization: Bearer <token>'
```

Anything that embeds text, uploading a file, adding knowledge, searching, needs an
OpenRouter API key on the acting user's account. Set it through the web app under Profile,
or with `PUT /api/me/openrouter-key`. Without one those routes answer `412` with an
explanation rather than failing silently.

## Testing

```
npm test
```

That builds `dist/`, type-checks `src/` and `test/`, and runs every `test/*.test.ts` on
Node's built-in `node:test` runner through `tsx`. There is no linter.

* `test/units.test.ts` covers the pure helpers: roles, model-name normalization,
  chunking, token hashing, JWT signing and the scrypt round trip.
* `test/harnesses.test.ts` runs the four verification harnesses below against the
  compiled `dist/`, and fails if any of them reports a failed check.

The harnesses can also be run on their own, after `npm run build`:

```
node .agents/wiki/context/t7-harness.js   # over real HTTP, real middleware
node .agents/wiki/context/t7-boot.js      # boot guards, one child process per case
node .agents/wiki/context/t8-kdf.js       # key derivation, and the route that stores one
node .agents/wiki/context/t8-boot.js      # the derivation across a process boundary
```

All four stub the database and nothing else — the application under test is the real one,
compiled. They stub the pool through `require.cache`, which is why the build emits
CommonJS. No test talks to a real PostgreSQL, so a schema change is still verified by
booting against a pgvector database and exercising the route.
