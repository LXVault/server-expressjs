# Docker

## The image

`Dockerfile` is a three stage build on `node:20-slim`:

1. **base** sets `/app` as the working directory and `NODE_ENV=production`.
2. **deps** copies `package*.json` and runs `npm install --omit=dev`, so the dependency
   layer is cached and rebuilt only when the manifest changes.
3. **runtime** copies those `node_modules` plus the source, exposes `4000`, drops to the
   unprivileged `node` user shipped with the base image, and runs `node src/index.js`.

```
docker build -t mcp-rag-server .
docker run --rm -p 4000:4000 \
  -e DATABASE_URL='postgresql://user:pass@host:5432/mcp_rag' \
  -e JWT_SECRET='...' \
  -e ENCRYPTION_KEY='...' \
  mcp-rag-server
```

## What it expects at runtime

A reachable PostgreSQL with pgvector, and the variables in [env.md](env.md). The container
carries no database of its own.

**The schema applies itself on boot.** `src/index.js` calls `runMigrations` from `src/config/migrate.js` after the
listener starts, so a fresh database needs no init step, no entrypoint script and no
init container. This is why the deployment works on managed platforms such as Render,
which offer no hook to run SQL before the process starts.

## What is not in the image

`.dockerignore` excludes `node_modules`, `.git`, `.env` files, build output, coverage, and
every `*.md` file. Documentation and the agent instruction set therefore never ship in the
image, which keeps it small and keeps repository metadata out of a deployed artifact.

## No compose file

A `docker-compose.yml.example` existed early on and was removed in favour of deploying to
Render. `.env.example` still mentions compose in a couple of comments; those are historical
and there is nothing in this repository to run with it. Bring up a database yourself and
point `DATABASE_URL` at it.
