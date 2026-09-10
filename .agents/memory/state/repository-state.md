---
name: memory-state-repository-state
description: Current known state of the mcp-rag-server backend after the instruction system setup. Overwritten in place, always current.
---

# Repository State

## What exists

A working Express.js backend, version `1.0.0`, CommonJS, no build step.

* Auth: register, login, JWT sessions, bcrypt password hashes.
* Projects: the `documents` table, with members and roles of `owner`, `admin`, `editor`,
  `viewer`.
* Per project execution tokens, at most one per user per project, presented by the MCP
  server so every action traces back to a user.
* Knowledge ingestion for `.md`, `.txt` and `.pdf`, chunked, embedded and stored.
* Semantic search by exact KNN over pgvector.
* Per user OpenRouter API keys, encrypted at rest with AES-256-GCM.
* An audit log of who did what through which token.
* A `/api/analysis` aggregate for the web app's charts.

## Stack

Node with Express 4, `pg`, PostgreSQL with pgvector, `multer` for uploads, `pdf-parse` for
PDF text, `jsonwebtoken` and `bcryptjs` for auth. Embeddings come from OpenRouter's
OpenAI compatible endpoint using each user's own key.

## Shared instruction set

Mode B consumer. The shared set is resolved through the `lxagents-agents-base` MCP
connector, adopted version `1.0.0`. Nothing from it is copied into this repository.

## What is not built

* No test suite and no linter configuration. The end to end check that verified the
  embedding split was written for that task and run against a local database; it is not
  part of the repository.
* No CI workflow.
* No migrations tooling. `db/init.sql` is applied idempotently on boot instead.
* No rate limiting on the API.
* No automatic backfill. Changing a project's embedding model never spends the user's
  OpenRouter credits on its own, by design.

## Embedding model handling

Resolved in `1.1.0`. Content and vectors are separate tables:
`document_chunks` holds text, `document_chunk_embeddings` holds one vector per
`(chunk_id, model_name)`. A project can hold vectors for several models at once, changing
the selected model deletes nothing, and switching back to a model the project already
covered is instant.

Chunks with no vector for the newly selected model are reported as pending coverage rather
than silently missing, and `POST /api/documents/:id/embeddings/backfill` embeds them in
batches of 100 using the caller's own OpenRouter key. Removing a model's vectors is a
deliberate call and is refused for the model currently selected.

Verified against PostgreSQL 16 with pgvector 0.6.0: the migration moves an older
database's single vector per chunk into the new table, collapses case variants of a model
name, is a no-op on every later boot, and search returns ranked rows on migrated data.

## Next obvious step

Surface coverage in the web app so a project owner can see that a switch left chunks
pending, and update the MCP tool descriptions so an assistant explains an uncovered
knowledge base instead of reporting it as empty.
