---
name: memory-tasks-embedding-matrix
description: Record of splitting chunk content from embeddings so a project can hold a vector per model and a model change stops destroying its knowledge base.
---

# Task: embedding matrix

**Goal.** A project could hold exactly one embedding model's vectors. Changing
`documents.embedding_model` made every existing chunk invisible to search, and the only
recovery was deleting and re-uploading the whole knowledge base. Make a model change
additive instead.

**Objective.** One chunk can carry a vector per model, keyed on `(chunk_id, model_name)`.
Changing the selected model deletes nothing, switching back to a covered model is instant,
and anything that reports a chunk count also reports how much of it search can reach.

**Detail.** The shape follows the example the user supplied: content keyed separately from
embeddings, with the model name part of the embedding key. No `version` column was added,
because `document_chunks.id` already identifies one immutable content revision and nothing
in the application edits a chunk in place. Existing data must survive, and the schema must
stay safe to re-run on every boot.

## Tasks

| # | Title | Scope | Repository | Branch | PR |
|---|---|---|---|---|---|
| 1 | Schema split, migration, coverage and backfill | The table, the migration, search, ingestion, the API | server-expressjs | `feat/embedding-matrix` | |
| 2 | Coverage and backfill in the web app | The embedding model card and its API methods | client-reactjs | `feat/embedding-matrix` | |
| 3 | Tool descriptions that explain coverage | `get_project` and `search_knowledge` wording, the tool reference | mcp | `feat/embedding-matrix` | |

Task 1 lands first: the other two read what it returns.

### Task 1 — feat/embedding-matrix

Landed:

* `db/init.sql`: `document_chunk_embeddings`, primary key `(chunk_id, model_name)`,
  cascading from the chunk, with a dimensionless `embedding` and the `dimensions` it came
  out at. `document_chunks` lost its `embedding` and `embedding_model` columns.
* A guarded migration that moves an older database's single vector per chunk into the new
  table, lower-casing the model name as it goes, then drops the old columns. It is a no-op
  on a fresh database and on every later boot.
* `normalizeModelName` and `isConventionalModelId` in `src/utils/embeddings.js`. Every
  `model_name` write is normalized; the full `{platform}/{model}` shape is enforced where a
  person chooses a model, and reads stay tolerant of a legacy bare name.
* `src/utils/embeddingCoverage.js`: `getCoverage` and `listStoredModels`.
* Search joins `document_chunk_embeddings` on `model_name`, so vectors from two models are
  never compared, and returns coverage beside the results.
* `addKnowledge` and `ingestFile` write the content row and the embedding row in one
  transaction.
* `POST /api/documents/:id/embeddings/backfill`, batched at 100 chunks, insert only, and
  `DELETE /api/documents/:id/embeddings/:model`, refused for the model in use.

Verified against PostgreSQL 16 with pgvector 0.6.0, not by inspection:

* The migration on a seeded old-shape database moved both vectors, collapsed
  `OpenAI/Text-Embedding-3-Small` and `openai/text-embedding-3-small` into one row, left
  the chunk that had no vector without one, and dropped the old columns.
* Re-applying the schema three times, and twice on a fresh database, changed nothing.
* An end to end run over the HTTP API with a stubbed OpenRouter: 18 checks, all passing,
  covering ingest, a model switch, backfill, backfill idempotency, switching back with no
  re-embedding, ranked search results, the refusal to delete the model in use, and the
  rejection of a model id with no platform segment.
* Two models with different dimensions held vectors for the same nine chunks at once.

Depends on: nothing. Task 2 and task 3 depend on the API shape above.

## Decisions

* **No `version` column.** The example table keyed content on `(knowledge_key, version)`.
  Chunk content here is immutable, nothing edits it in place, and `document_chunks.id`
  already identifies one revision, so a version column would have had no writer. Editing a
  chunk would create a new row with a new id.
* **Backfill is explicit, not automatic.** Embedding spends the acting user's own
  OpenRouter credits, so a model change never triggers it. Batched at 100 chunks so one
  request cannot run for minutes behind a proxy.
* **Old vectors are kept on a switch.** That is what makes the change reversible, and it is
  why removing them is a separate deliberate call.
* **Model name convention enforced at the choice, not on read.** A database written before
  the convention may hold a bare name, and its chunks must keep working.
