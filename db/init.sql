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

CREATE TABLE IF NOT EXISTS document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    -- Dimensionless `vector` so projects can pick embedding models of different
    -- sizes. `embedding_model` records which model produced this vector; search
    -- only compares chunks embedded with the project's current model (same dim).
    embedding vector,
    embedding_model VARCHAR(100),
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
-- NOTE: no HNSW/ivfflat index on `embedding` — the column is dimensionless to
-- allow per-project model choice, and pgvector ANN indexes require a fixed
-- dimension. Search uses exact KNN (`<=>`), which is fine at this scale.

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

-- Per-project embedding model + per-chunk provenance.
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(100)
    NOT NULL DEFAULT 'openai/text-embedding-3-small';
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(100);

-- Relax the embedding column to a dimensionless vector so projects can choose
-- models of differing sizes. Drop the dimension-specific ANN index first.
DROP INDEX IF EXISTS idx_document_chunks_embedding;
ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector;

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
-- text is split into many `document_chunks` (one embedding per chunk) for
-- semantic search. Deleting a file row cascades to all of its chunks.
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
