---
name: project-wiki-index
description: Index of wiki/, the human documentation tree for this backend. Release logs are routed from logs-index instead.
---

# Project Wiki Index

**Scope:** `wiki/`, excluding `wiki/logs/`
**Parent:** [`root-index.md`](root-index.md)

## information

| File | Purpose |
|---|---|
| [`../../wiki/information/overview.md`](../../wiki/information/overview.md) | What the service is, what it stores, and the concepts a newcomer needs before reading code. |
| [`../../wiki/information/architecture.md`](../../wiki/information/architecture.md) | Request flow, layer boundaries, the database schema, and the two authentication paths. |

## environments

| File | Purpose |
|---|---|
| [`../../wiki/environments/setup.md`](../../wiki/environments/setup.md) | Running the API locally against PostgreSQL with pgvector, and verifying it works. |
| [`../../wiki/environments/env.md`](../../wiki/environments/env.md) | Every environment variable the server reads, its fallback, and what breaks when it is wrong. |
| [`../../wiki/environments/docker.md`](../../wiki/environments/docker.md) | The container image, what it expects at runtime, and how the schema is applied on boot. |

## Maintenance

Any page added to or removed from `wiki/` is reflected in this table in the same commit.
`wiki/logs/` is owned by [`logs-index.md`](logs-index.md) and never listed here.
