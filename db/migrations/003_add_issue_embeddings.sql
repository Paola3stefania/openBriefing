-- Migration 003: Add issue_embeddings table
-- Stores OpenAI embeddings for GitHub issues to avoid redundant API calls

-- Issue embeddings table
CREATE TABLE IF NOT EXISTS issue_embeddings (
  issue_number INTEGER PRIMARY KEY,
  embedding JSONB NOT NULL, -- Array of floats (1536 dimensions for text-embedding-3-small)
  content_hash TEXT NOT NULL, -- MD5 hash of issue content (title + body + labels) for change detection
  model TEXT NOT NULL, -- Embedding model used (e.g., "text-embedding-3-small")
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Index for content_hash lookups (for change detection)
CREATE INDEX IF NOT EXISTS idx_issue_embeddings_content_hash ON issue_embeddings(content_hash);

-- Index for model lookups (for cache invalidation when model changes)
CREATE INDEX IF NOT EXISTS idx_issue_embeddings_model ON issue_embeddings(model);

-- Update timestamp trigger
CREATE TRIGGER update_issue_embeddings_updated_at BEFORE UPDATE ON issue_embeddings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


