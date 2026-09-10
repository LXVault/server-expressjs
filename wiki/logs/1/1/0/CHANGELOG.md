# 1.1.0

Released 2026-09-10.

A project can now hold embeddings for several models at once. Changing a project's
embedding model no longer destroys its knowledge base.

## Added

* `document_chunk_embeddings`, one vector per `(chunk_id, model_name)`, cascading from the
  chunk. The `embedding` column is dimensionless, so vectors from models of different sizes
  sit in the table together, and `dimensions` records the size each row came out at.
* `POST /api/documents/:id/embeddings/backfill`, which embeds the chunks that have no
  vector for the project's current model using the caller's own OpenRouter key. Insert
  only, so repeating it is safe, and batched at 100 chunks so one request cannot run for
  minutes.
* `DELETE /api/documents/:id/embeddings/:model`, which reclaims the space held by a model
  the project no longer uses. Refused for the model currently selected.
* Coverage on every endpoint that reports on a project: the total chunks, how many are
  embedded with the selected model, and how many are pending. `GET` and `PUT` on the
  embedding model also return every model the project already holds vectors for, which is
  what makes a switch legible as reversible.
* `normalizeModelName` and `isConventionalModelId` in `src/utils/embeddings.js`, and
  `src/utils/embeddingCoverage.js`.
* An audit entry for changing the model, backfilling, and deleting a model's embeddings.

## Changed

* Semantic search joins `document_chunk_embeddings` on `model_name` instead of filtering a
  column on the chunk, so vectors produced by two different models are never compared.
* `POST /api/mcp/search` returns a `coverage` block beside its results, so an empty result
  can be explained as "nothing matched" rather than confused with "this knowledge base is
  not embedded with the model this project currently uses".
* `GET /api/mcp/project` reports `searchable_chunk_count` and `chunks_awaiting_embedding`
  alongside `chunk_count`.
* File ingestion and `add_knowledge` write the chunk and its embedding as two rows in one
  transaction.
* A stored model name is lower-cased before every write, so one model cannot exist under
  two spellings. `PUT /api/documents/:id/embedding-model` now requires a
  provider-namespaced id of the form `platform/model`.
* Existing databases are migrated in place on boot: vectors move into the new table with
  their model name lower-cased, then the old columns are dropped. The step is guarded, so
  it runs once and is a no-op afterwards and on a fresh database.

## Removed

* `document_chunks.embedding` and `document_chunks.embedding_model`. Holding the text and
  one vector in the same row is what limited a project to a single model.
