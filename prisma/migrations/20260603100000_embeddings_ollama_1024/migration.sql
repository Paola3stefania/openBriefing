-- Switch embedding storage from halfvec(3072) (OpenAI text-embedding-3-large)
-- to halfvec(1024) (Ollama mxbai-embed-large).
--
-- Vectors from the previous model occupy a different vector space and can't
-- be mixed with the new ones, so this migration:
--   * empties every embedding-only join table (issue/thread/code_file/
--     code_section/feature/documentation/documentation_section/group/memory),
--   * NULLs the inline embedding column on `pr_learnings` (which keeps its
--     metadata rows so we don't lose the issue/PR/diff context).
-- Run `npm run reembed:all` afterwards to repopulate every vector with the
-- new model. HNSW indexes are dropped before the type change and rebuilt
-- after — index build is a no-op on empty tables and gets the right shape
-- once data flows back in.

-- 1. Drop existing HNSW indexes (they reference halfvec(3072), incompatible).
DROP INDEX IF EXISTS issue_embeddings_embedding_hnsw;
DROP INDEX IF EXISTS thread_embeddings_embedding_hnsw;
DROP INDEX IF EXISTS group_embeddings_embedding_hnsw;
DROP INDEX IF EXISTS feature_embeddings_embedding_hnsw;
DROP INDEX IF EXISTS code_file_embeddings_embedding_hnsw;
DROP INDEX IF EXISTS code_section_embeddings_embedding_hnsw;
DROP INDEX IF EXISTS documentation_embeddings_embedding_hnsw;
DROP INDEX IF EXISTS documentation_section_embeddings_embedding_hnsw;
DROP INDEX IF EXISTS memory_entry_embeddings_embedding_hnsw;
DROP INDEX IF EXISTS pr_learnings_embedding_hnsw;

-- 2. Empty embedding-only tables. The source rows (github_issues, code_files,
-- etc.) keep their data; only the cached vector representations are cleared.
TRUNCATE TABLE
  issue_embeddings,
  thread_embeddings,
  group_embeddings,
  feature_embeddings,
  code_file_embeddings,
  code_section_embeddings,
  documentation_embeddings,
  documentation_section_embeddings,
  memory_entry_embeddings;

-- 3. pr_learnings keeps its rows; just clear the embedding column.
UPDATE pr_learnings SET embedding = NULL WHERE embedding IS NOT NULL;

-- 4. Resize halfvec columns to 1024. Safe now because every column is
-- empty/NULL — no per-row data conversion happens.
ALTER TABLE issue_embeddings                 ALTER COLUMN embedding TYPE halfvec(1024);
ALTER TABLE thread_embeddings                ALTER COLUMN embedding TYPE halfvec(1024);
ALTER TABLE group_embeddings                 ALTER COLUMN embedding TYPE halfvec(1024);
ALTER TABLE feature_embeddings               ALTER COLUMN embedding TYPE halfvec(1024);
ALTER TABLE code_file_embeddings             ALTER COLUMN embedding TYPE halfvec(1024);
ALTER TABLE code_section_embeddings          ALTER COLUMN embedding TYPE halfvec(1024);
ALTER TABLE documentation_embeddings         ALTER COLUMN embedding TYPE halfvec(1024);
ALTER TABLE documentation_section_embeddings ALTER COLUMN embedding TYPE halfvec(1024);
ALTER TABLE memory_entry_embeddings          ALTER COLUMN embedding TYPE halfvec(1024);
ALTER TABLE pr_learnings                     ALTER COLUMN embedding TYPE halfvec(1024);

-- 5. Recreate HNSW indexes on halfvec(1024). pr_learnings keeps its partial
-- index (embedding nullable until a worker fills it post-merge).
CREATE INDEX issue_embeddings_embedding_hnsw                 ON issue_embeddings                 USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX thread_embeddings_embedding_hnsw                ON thread_embeddings                USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX group_embeddings_embedding_hnsw                 ON group_embeddings                 USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX feature_embeddings_embedding_hnsw               ON feature_embeddings               USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX code_file_embeddings_embedding_hnsw             ON code_file_embeddings             USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX code_section_embeddings_embedding_hnsw          ON code_section_embeddings          USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX documentation_embeddings_embedding_hnsw         ON documentation_embeddings         USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX documentation_section_embeddings_embedding_hnsw ON documentation_section_embeddings USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX memory_entry_embeddings_embedding_hnsw          ON memory_entry_embeddings          USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX pr_learnings_embedding_hnsw                     ON pr_learnings                     USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL;
