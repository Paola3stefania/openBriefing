-- Agent-memory "brain" → pgvector.
-- Converts memory_entry_embeddings.embedding from JSONB to a real vector(1536)
-- column and adds an HNSW index so related-insight / memory search is an
-- indexed approximate-nearest-neighbour query (`<=>`) instead of a JS cosine
-- loop over the 200 most-recent rows.

-- 1. Enable the pgvector extension (no-op if already present).
--    Supported on Neon, Supabase, Vercel Postgres, and local Postgres with the
--    pgvector extension installed.
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Convert the JSONB embedding column to vector(1536).
--    Existing rows store the embedding as a JSON array; its text form
--    (`[0.1,0.2,...]`) is a valid pgvector input literal, so we cast through
--    text. Any pre-existing row whose array length != 1536 will fail the cast
--    — that only happens if a different embedding model was used; recompute
--    those via `npm run backfill:memory-embeddings` after the migration.
ALTER TABLE "memory_entry_embeddings"
  ALTER COLUMN "embedding" TYPE vector(1536)
  USING ("embedding"::text)::vector;

-- 3. HNSW index for cosine distance (matches the `<=>` operator used in
--    memory.ts searchMemory and briefing distill.ts relatedInsights).
CREATE INDEX IF NOT EXISTS "memory_entry_embeddings_embedding_hnsw"
  ON "memory_entry_embeddings"
  USING hnsw ("embedding" vector_cosine_ops);
