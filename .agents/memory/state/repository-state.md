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

* No test suite and no linter configuration.
* No CI workflow.
* No migrations tooling. `db/init.sql` is applied idempotently on boot instead.
* No rate limiting on the API.

## Known limitation being worked on

`document_chunks` stores the content and its embedding in the same row, with a single
`embedding_model` column. A project can therefore hold exactly one model's vectors, and
changing `documents.embedding_model` makes every existing chunk invisible to search, since
`mcpController.search` filters on an exact model match. Recovering means deleting and
re-uploading the knowledge base.

## Next obvious step

Split content from embeddings so one chunk can carry a vector per model, keyed on
`(chunk_id, model_name)`, and make a model switch non destructive.
