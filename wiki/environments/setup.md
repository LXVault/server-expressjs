# Local Setup

## Requirements

* Node.js 20 or newer. The container image is built on `node:20-slim`.
* PostgreSQL 14 or newer with the `pgvector` extension available. The schema runs
  `CREATE EXTENSION IF NOT EXISTS vector` on boot, so the extension must be installed on
  the server even though the database does not need it enabled beforehand.

## Steps

```
npm install
cp .env.example .env      # optional, every value has a fallback
npm run dev               # nodemon, reloads on change
```

The server listens on `PORT`, default `4000`. Every variable and its fallback:
[env.md](env.md).

## Verify

```
curl localhost:4000/health
```

A healthy server answers `{"status":"ok","db":"up"}`. If it answers `db:"down"`, the
process is running but `DATABASE_URL` is wrong or the database is unreachable; the API
still serves requests and every database backed route will error.

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

There is no test suite and no linter in this repository. Verification is manual: boot the
server and exercise the route you changed.
