-- Documentation cache table
-- Stores fetched documentation to avoid re-fetching on every request

CREATE TABLE IF NOT EXISTS documentation_cache (
  url TEXT PRIMARY KEY,
  title TEXT,
  content TEXT NOT NULL,
  sections JSONB,
  fetched_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_documentation_cache_fetched_at ON documentation_cache(fetched_at DESC);

-- Update timestamp trigger
CREATE TRIGGER update_documentation_cache_updated_at BEFORE UPDATE ON documentation_cache
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

