-- Migration 005: Create normalized features table
-- Features are stored as individual rows (one row per feature) instead of JSONB array

-- Create features table (one row per feature)
CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  priority TEXT,
  related_keywords TEXT[],
  documentation_section TEXT,
  documentation_urls TEXT[], -- URLs this feature was extracted from
  extracted_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Add missing columns if table already exists
ALTER TABLE features ADD COLUMN IF NOT EXISTS documentation_urls TEXT[];
ALTER TABLE features ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMP DEFAULT NOW();

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_features_name ON features(name);
CREATE INDEX IF NOT EXISTS idx_features_category ON features(category);
CREATE INDEX IF NOT EXISTS idx_features_priority ON features(priority);
CREATE INDEX IF NOT EXISTS idx_features_keywords ON features USING GIN(related_keywords);
CREATE INDEX IF NOT EXISTS idx_features_urls ON features USING GIN(documentation_urls);
CREATE INDEX IF NOT EXISTS idx_features_extracted_at ON features(extracted_at DESC);

-- Update timestamp trigger
CREATE TRIGGER update_features_updated_at BEFORE UPDATE ON features
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

