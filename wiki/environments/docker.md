# Docker

## The image

`Dockerfile` is a four stage build on `node:22-slim`:

1. **base** sets `/app` as the working directory and `NODE_ENV=production`.
2. **deps** copies `package*.json` and runs `npm ci --omit=dev`, so the dependency
   layer is cached and rebuilt only when the manifest changes, and so the image installs
   exactly the tree that was audited rather than resolving version ranges again at build
   time. Node 20 reached end of life in April 2026, so the previous base image no longer
   received security fixes.
3. **build** installs every dependency with `npm ci --include=dev`, because the base
   stage's `NODE_ENV=production` would otherwise skip the TypeScript compiler, then runs
   `npm run build` to compile `src/` into `dist/`.
4. **runtime** copies the production `node_modules`, the repository, and `dist/` from the
   build stage, exposes `4000`, drops to the unprivileged `node` user shipped with the
   base image, and runs `node dist/index.js`. `.dockerignore` excludes any local `dist/`,
   so the image always carries what the build stage compiled.

```
docker build -t mcp-rag-server .
docker run --rm -p 4000:4000 \
  -e DATABASE_URL='postgresql://user:pass@host:5432/mcp_rag' \
  -e JWT_SECRET='...' \
  -e ENCRYPTION_KEY='...' \
  mcp-rag-server
```

Because the base stage sets `NODE_ENV=production`, the image runs with the secrets guard
armed: if `JWT_SECRET`, `ENCRYPTION_KEY` or `DATABASE_URL` is missing or still holds its
published default, the process exits at startup rather than serving. Passing the three
variables above is what makes the container start.

## What it expects at runtime

A reachable PostgreSQL with pgvector, and the variables in [env.md](env.md). The container
carries no database of its own.

**The schema applies itself on boot.** `dist/index.js`, compiled from `src/index.ts`, calls `runMigrations` from `src/config/migrate.ts` after the
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
