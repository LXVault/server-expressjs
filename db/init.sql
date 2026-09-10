-- ---------------------------------------------------------------------------
-- MCP Server + Knowledge Base (RAG) — database schema
-- Applied automatically by the `db` service on first container boot.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Per-project execution tokens. Each user may hold at most ONE active token
-- per project (enforced by the uq_api_tokens_user_project unique index below).
-- These tokens are presented by the MCP server so every action it performs can
-- be traced back to the user who generated the token.
-- NOTE: `project_id` references documents(id); the FK is added after the
-- documents table is defined further down (forward-reference constraint).
CREATE TABLE IF NOT EXISTS api_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID,
    token_hash VARCHAR(255) UNIQUE NOT NULL,
    token_name VARCHAR(100) NOT NULL DEFAULT 'Project token',
    expires_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    summary TEXT,
    -- OpenRouter embedding model used for this project's semantic search.
    -- Configurable by the project owner/admins.
    embedding_model VARCHAR(100) NOT NULL DEFAULT 'openai/text-embedding-3-small',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS document_members (
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'editor',
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (document_id, user_id)
);

-- Chunk CONTENT only. The vectors live in document_chunk_embeddings, one row
-- per model, so a chunk can be embedded by several models at once and changing
-- a project's model never invalidates what is already stored.
CREATE TABLE IF NOT EXISTS document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    token_id UUID REFERENCES api_tokens(id) ON DELETE SET NULL,
    action_type VARCHAR(100) NOT NULL,
    resource_table VARCHAR(100),
    resource_id UUID,
    action_details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_doc_id ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_token_id ON audit_logs(token_id);
-- NOTE: no HNSW/ivfflat index on document_chunk_embeddings.embedding. The
-- column is dimensionless so one project can hold vectors from models of
-- different sizes, and pgvector ANN indexes require a fixed dimension. Search
-- uses exact KNN (`<=>`), which is fine at this scale.

-- ---------------------------------------------------------------------------
-- Per-project token wiring (runs after `documents` exists).
-- Kept idempotent so it is safe on both fresh and pre-existing databases.
-- ---------------------------------------------------------------------------

-- Bring older databases up to date with the columns added above.
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP WITH TIME ZONE;

-- Link a token to the project (document) it grants access to.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_api_tokens_project'
    ) THEN
        ALTER TABLE api_tokens
            ADD CONSTRAINT fk_api_tokens_project
            FOREIGN KEY (project_id) REFERENCES documents(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Enforce: one user may hold at most one token per project.
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_tokens_user_project
    ON api_tokens(user_id, project_id);

CREATE INDEX IF NOT EXISTS idx_api_tokens_project_id ON api_tokens(project_id);

-- ---------------------------------------------------------------------------
-- Semantic search wiring (idempotent for pre-existing databases).
-- ---------------------------------------------------------------------------

-- The project's SELECTED embedding model. Only this column records a choice;
-- everything already embedded stays queryable whatever it is set to.
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(100)
    NOT NULL DEFAULT 'openai/text-embedding-3-small';

-- Drop the dimension-specific ANN index left by older databases.
DROP INDEX IF EXISTS idx_document_chunks_embedding;

-- ---------------------------------------------------------------------------
-- One embedding per (chunk, model).
-- ---------------------------------------------------------------------------
-- A chunk's text and its vector are different facts with different lifetimes:
-- the text is written once, while a vector exists per embedding model and a
-- project may change model at any time. Keeping them in one row meant a chunk
-- could hold exactly one model's vector, so switching model made the whole
-- knowledge base unsearchable until it was deleted and re-uploaded.
--
-- Splitting them makes a model change additive. Vectors for the previous model
-- stay, switching back is instant, and the only cost of a new model is
-- embedding the chunks that do not have a row for it yet.
--
-- `embedding` is dimensionless because two models produce different sizes, and
-- rows for both can sit in this table at once. `model_name` follows the shared
-- {platform}/{model} convention and is lowercased before every write, so one
-- model has exactly one spelling here.
CREATE TABLE IF NOT EXISTS document_chunk_embeddings (
    chunk_id UUID NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
    model_name VARCHAR(100) NOT NULL,
    embedding vector NOT NULL,
    dimensions INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chunk_id, model_name)
);

-- Search always filters by model, and the backfill counts by it.
CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model
    ON document_chunk_embeddings(model_name);

-- Move an older database's single vector per chunk into the table above, then
-- drop the columns it came from. Guarded on the column still existing, so this
-- runs exactly once and is a no-op on every later boot and on a fresh database.
DO $$
BEGIN
    -- Both columns are needed to attribute a vector to a model. They were always
    -- created together, so this is the only shape worth migrating; the drops
    -- below are guarded separately so a half-migrated database still converges.
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'document_chunks' AND column_name = 'embedding'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'document_chunks' AND column_name = 'embedding_model'
    ) THEN
        INSERT INTO document_chunk_embeddings (chunk_id, model_name, embedding)
        SELECT id, lower(btrim(embedding_model)), embedding
          FROM document_chunks
         WHERE embedding IS NOT NULL
           AND embedding_model IS NOT NULL
           AND btrim(embedding_model) <> ''
        ON CONFLICT (chunk_id, model_name) DO NOTHING;
    END IF;
END $$;

ALTER TABLE document_chunks DROP COLUMN IF EXISTS embedding;
ALTER TABLE document_chunks DROP COLUMN IF EXISTS embedding_model;

-- Lowercase any model name an older database wrote before the convention was
-- enforced at the write, so one model cannot exist under two spellings.
UPDATE documents
   SET embedding_model = lower(btrim(embedding_model))
 WHERE embedding_model <> lower(btrim(embedding_model));

-- Per-user OpenRouter API key, encrypted at rest (AES-256-GCM).
-- One row per user; the secret lives in its own table, isolated from `users`.
-- We store ciphertext + iv + auth tag separately (never a hash — it must be
-- decryptable for outbound OpenRouter calls).
CREATE TABLE IF NOT EXISTS user_openrouter_keys (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    key_ciphertext TEXT NOT NULL,
    key_iv TEXT NOT NULL,
    key_auth_tag TEXT NOT NULL,
    key_last4 VARCHAR(8),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Knowledge-base file uploads (RAG ingestion).
-- ---------------------------------------------------------------------------
-- A project's knowledge base can be populated by uploading source files
-- (.md / .txt / .pdf). Each uploaded file is recorded here as a single row —
-- the "central index" of what a project was built from — while its extracted
-- text is split into many `document_chunks` for semantic search, each of which
-- carries one vector per embedding model. Deleting a file row cascades to its
-- chunks, and those cascade to their vectors.
CREATE TABLE IF NOT EXISTS document_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    filename VARCHAR(255) NOT NULL,
    file_type VARCHAR(10) NOT NULL,            -- md | txt | pdf
    byte_size INTEGER,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_document_files_doc_id ON document_files(document_id);

-- Link each chunk back to the file it was extracted from so deleting a file
-- removes exactly its chunks. NULL for chunks added directly (e.g. add_knowledge).
ALTER TABLE document_chunks
    ADD COLUMN IF NOT EXISTS file_id UUID REFERENCES document_files(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_document_chunks_file_id ON document_chunks(file_id);
