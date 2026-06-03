-- Repair migration: create tables that were historically introduced via
-- `prisma db push` and never captured as a migration. On a fresh database the
-- later ALTER migrations (add_project_id_to_agent_sessions, add_plan_steps,
-- add_session_external_refs, add_memory_session_link, memory_pgvector) fail
-- with "relation ... does not exist" because nothing ever created the base
-- tables.
--
-- Ordered (20260214) BEFORE the first migration that alters agent_sessions
-- (20260219). memory_entries / memory_entry_embeddings are first altered at
-- 20260506050000, so creating them here is also in time.
--
-- Everything uses IF NOT EXISTS so this is a no-op on existing databases that
-- already have these tables — making it safe to insert into migration history.
--
-- Columns added by LATER migrations are intentionally omitted here so those
-- migrations still apply cleanly:
--   * agent_sessions.project_id        -> 20260219000000
--   * agent_sessions.plan_steps        -> 20260220000000
--   * agent_sessions.external_refs     -> 20260506040000
--   * memory_entries.session_id (+FK)  -> 20260506050000
-- memory_entry_embeddings.embedding is created as JSONB here (its historical
-- type); migration 20260602000000_memory_pgvector converts it to vector(1536).

-- agent_sessions ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "agent_sessions" (
    "id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "scope" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "files_edited" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "decisions_made" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "open_items" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "issues_referenced" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "tools_used" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_sessions_started_at_idx"
    ON "agent_sessions" ("started_at" DESC);

CREATE INDEX IF NOT EXISTS "agent_sessions_scope_idx"
    ON "agent_sessions" USING GIN ("scope");

-- memory_entries ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "memory_entries" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL DEFAULT 'default',
    "content" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT 'conversation',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "memory_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "memory_entries_project_id_created_at_idx"
    ON "memory_entries" ("project_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "memory_entries_tags_idx"
    ON "memory_entries" USING GIN ("tags");

-- memory_entry_embeddings ---------------------------------------------------
-- embedding is JSONB here; 20260602000000_memory_pgvector converts it to
-- vector(1536) and adds the HNSW index.
CREATE TABLE IF NOT EXISTS "memory_entry_embeddings" (
    "memory_id" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "memory_entry_embeddings_pkey" PRIMARY KEY ("memory_id"),
    CONSTRAINT "memory_entry_embeddings_memory_id_fkey"
        FOREIGN KEY ("memory_id") REFERENCES "memory_entries" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);
