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
    embedding vector(1536),
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
CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding ON document_chunks USING hnsw (embedding vector_cosine_ops);

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
