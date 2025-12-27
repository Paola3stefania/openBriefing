-- Normalize documentation sections into a separate table
-- Removes JSONB column and uses proper relational structure

-- Create sections table
CREATE TABLE IF NOT EXISTS documentation_sections (
  id SERIAL PRIMARY KEY,
  documentation_url TEXT NOT NULL REFERENCES documentation_cache(url) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  section_url TEXT,
  section_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_documentation_sections_url FOREIGN KEY (documentation_url) REFERENCES documentation_cache(url) ON DELETE CASCADE
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_documentation_sections_url ON documentation_sections(documentation_url);
CREATE INDEX IF NOT EXISTS idx_documentation_sections_order ON documentation_sections(documentation_url, section_order);

-- Remove JSONB sections column from documentation_cache
ALTER TABLE documentation_cache DROP COLUMN IF EXISTS sections;

