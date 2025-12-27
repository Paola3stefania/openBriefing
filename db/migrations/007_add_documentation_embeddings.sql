-- Migration 007: Add embeddings tables for documentation and features
-- Stores OpenAI embeddings for documentation sections, full docs, and features

-- Documentation section embeddings table
CREATE TABLE IF NOT EXISTS documentation_section_embeddings (
  section_id INTEGER PRIMARY KEY REFERENCES documentation_sections(id) ON DELETE CASCADE,
  documentation_url TEXT NOT NULL, -- Denormalized for easier queries
  embedding JSONB NOT NULL, -- Array of floats (1536 dimensions)
  content_hash TEXT NOT NULL, -- MD5 hash of section content (title + content) for change detection
  model TEXT NOT NULL, -- Embedding model used
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for documentation_section_embeddings
CREATE INDEX IF NOT EXISTS idx_doc_section_embeddings_url ON documentation_section_embeddings(documentation_url);
CREATE INDEX IF NOT EXISTS idx_doc_section_embeddings_hash ON documentation_section_embeddings(content_hash);
CREATE INDEX IF NOT EXISTS idx_doc_section_embeddings_model ON documentation_section_embeddings(model);

-- Update timestamp trigger
CREATE TRIGGER update_doc_section_embeddings_updated_at BEFORE UPDATE ON documentation_section_embeddings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Full documentation embeddings table
CREATE TABLE IF NOT EXISTS documentation_embeddings (
  documentation_url TEXT PRIMARY KEY REFERENCES documentation_cache(url) ON DELETE CASCADE,
  embedding JSONB NOT NULL, -- Array of floats (1536 dimensions)
  content_hash TEXT NOT NULL, -- MD5 hash of doc content (title + content) for change detection
  model TEXT NOT NULL, -- Embedding model used
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for documentation_embeddings
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_hash ON documentation_embeddings(content_hash);
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_model ON documentation_embeddings(model);

-- Update timestamp trigger
CREATE TRIGGER update_doc_embeddings_updated_at BEFORE UPDATE ON documentation_embeddings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Feature embeddings table
CREATE TABLE IF NOT EXISTS feature_embeddings (
  feature_id TEXT PRIMARY KEY REFERENCES features(id) ON DELETE CASCADE,
  embedding JSONB NOT NULL, -- Array of floats (1536 dimensions)
  content_hash TEXT NOT NULL, -- MD5 hash of feature content (name + description + keywords) for change detection
  model TEXT NOT NULL, -- Embedding model used
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for feature_embeddings
CREATE INDEX IF NOT EXISTS idx_feature_embeddings_hash ON feature_embeddings(content_hash);
CREATE INDEX IF NOT EXISTS idx_feature_embeddings_model ON feature_embeddings(model);

-- Update timestamp trigger
CREATE TRIGGER update_feature_embeddings_updated_at BEFORE UPDATE ON feature_embeddings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

