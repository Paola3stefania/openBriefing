-- Convert every embedding column in the schema to a single, indexed pgvector
-- type. Before this migration:
--   * memory_entry_embeddings.embedding was vector(1536) — partial conversion
--     in 20260602000000_memory_pgvector.
--   * 9 other embedding columns (issue/thread/group/feature/code_file/
--     code_section/documentation/documentation_section/pr_learnings) were
--     stored as JSONB float arrays. No similarity index, every cosine search
--     materialised the entire table into JS.
--
-- After this migration, all 10 columns are halfvec(3072) with an HNSW cosine
-- index. We pick halfvec(3072) over vector(3072) because:
--   * existing data is 3072-dim (text-embedding-3-large at default), so no
--     re-embedding cost,
--   * pgvector's HNSW supports halfvec up to 4000 dims but only supports
--     plain vector up to 2000 dims — vector(3072) cannot be HNSW-indexed,
--   * halfvec uses 16-bit floats: half the storage of vector(3072), the
--     numerical noise is well-tolerated by cosine similarity (this is the
--     standard recommendation in pgvector's own docs for >2000-dim models).
--
-- The conversion casts JSONB → text → halfvec. JSON arrays serialise to
-- `[0.1,0.2,...]`, which is a valid halfvec input literal, so existing rows
-- migrate in place. Rows whose array length != 3072 will fail the cast — if
-- any rows like that exist (mixed-model history), they need to be deleted or
-- recomputed before applying this migration.

-- 1. Drop the existing vector(1536) HNSW index — its operator class doesn't
--    apply to halfvec.
DROP INDEX IF EXISTS "memory_entry_embeddings_embedding_hnsw";

-- 2. memory_entry_embeddings.embedding: vector(1536) → halfvec(3072).
--    The Neon column is currently empty (the 2 pg14 rows were 3072-dim and
--    didn't fit in vector(1536) anyway), so the cast is trivial. Once this
--    runs the schema and the model dimension match for the first time.
ALTER TABLE "memory_entry_embeddings"
  ALTER COLUMN "embedding" TYPE halfvec(3072)
  USING ("embedding"::text)::halfvec;

-- 3. Convert the 9 JSONB embedding columns. Use a CASE expression so NULLs
--    stay NULL (only pr_learnings.embedding is currently nullable, but the
--    pattern is harmless on NOT NULL columns and keeps the migration uniform).
ALTER TABLE "issue_embeddings"
  ALTER COLUMN "embedding" TYPE halfvec(3072)
  USING (CASE WHEN "embedding" IS NULL THEN NULL ELSE ("embedding"::text)::halfvec END);

ALTER TABLE "thread_embeddings"
  ALTER COLUMN "embedding" TYPE halfvec(3072)
  USING (CASE WHEN "embedding" IS NULL THEN NULL ELSE ("embedding"::text)::halfvec END);

ALTER TABLE "group_embeddings"
  ALTER COLUMN "embedding" TYPE halfvec(3072)
  USING (CASE WHEN "embedding" IS NULL THEN NULL ELSE ("embedding"::text)::halfvec END);

ALTER TABLE "feature_embeddings"
  ALTER COLUMN "embedding" TYPE halfvec(3072)
  USING (CASE WHEN "embedding" IS NULL THEN NULL ELSE ("embedding"::text)::halfvec END);

ALTER TABLE "code_file_embeddings"
  ALTER COLUMN "embedding" TYPE halfvec(3072)
  USING (CASE WHEN "embedding" IS NULL THEN NULL ELSE ("embedding"::text)::halfvec END);

ALTER TABLE "code_section_embeddings"
  ALTER COLUMN "embedding" TYPE halfvec(3072)
  USING (CASE WHEN "embedding" IS NULL THEN NULL ELSE ("embedding"::text)::halfvec END);

ALTER TABLE "documentation_embeddings"
  ALTER COLUMN "embedding" TYPE halfvec(3072)
  USING (CASE WHEN "embedding" IS NULL THEN NULL ELSE ("embedding"::text)::halfvec END);

ALTER TABLE "documentation_section_embeddings"
  ALTER COLUMN "embedding" TYPE halfvec(3072)
  USING (CASE WHEN "embedding" IS NULL THEN NULL ELSE ("embedding"::text)::halfvec END);

ALTER TABLE "pr_learnings"
  ALTER COLUMN "embedding" TYPE halfvec(3072)
  USING (CASE WHEN "embedding" IS NULL THEN NULL ELSE ("embedding"::text)::halfvec END);

-- 4. HNSW indexes for cosine distance on every embedding column. After this
--    every similarity search hits an indexed `<=>` query instead of a JS
--    cosine loop.
CREATE INDEX IF NOT EXISTS "memory_entry_embeddings_embedding_hnsw"
  ON "memory_entry_embeddings"
  USING hnsw ("embedding" halfvec_cosine_ops);

CREATE INDEX IF NOT EXISTS "issue_embeddings_embedding_hnsw"
  ON "issue_embeddings"
  USING hnsw ("embedding" halfvec_cosine_ops);

CREATE INDEX IF NOT EXISTS "thread_embeddings_embedding_hnsw"
  ON "thread_embeddings"
  USING hnsw ("embedding" halfvec_cosine_ops);

CREATE INDEX IF NOT EXISTS "group_embeddings_embedding_hnsw"
  ON "group_embeddings"
  USING hnsw ("embedding" halfvec_cosine_ops);

CREATE INDEX IF NOT EXISTS "feature_embeddings_embedding_hnsw"
  ON "feature_embeddings"
  USING hnsw ("embedding" halfvec_cosine_ops);

CREATE INDEX IF NOT EXISTS "code_file_embeddings_embedding_hnsw"
  ON "code_file_embeddings"
  USING hnsw ("embedding" halfvec_cosine_ops);

CREATE INDEX IF NOT EXISTS "code_section_embeddings_embedding_hnsw"
  ON "code_section_embeddings"
  USING hnsw ("embedding" halfvec_cosine_ops);

CREATE INDEX IF NOT EXISTS "documentation_embeddings_embedding_hnsw"
  ON "documentation_embeddings"
  USING hnsw ("embedding" halfvec_cosine_ops);

CREATE INDEX IF NOT EXISTS "documentation_section_embeddings_embedding_hnsw"
  ON "documentation_section_embeddings"
  USING hnsw ("embedding" halfvec_cosine_ops);

CREATE INDEX IF NOT EXISTS "pr_learnings_embedding_hnsw"
  ON "pr_learnings"
  USING hnsw ("embedding" halfvec_cosine_ops)
  WHERE "embedding" IS NOT NULL;
