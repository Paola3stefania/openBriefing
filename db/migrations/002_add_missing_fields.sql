-- Migration 002: Add missing fields to match JSON structure
-- Adds affects_features and linear_issue_identifier to groups table

-- Add affects_features column (stores array of feature IDs/names)
ALTER TABLE groups 
ADD COLUMN IF NOT EXISTS affects_features JSONB DEFAULT '[]'::jsonb;

-- Add linear_issue_identifier column (stores human-readable ID like "LIN-123")
ALTER TABLE groups 
ADD COLUMN IF NOT EXISTS linear_issue_identifier TEXT;

-- Add index for affects_features queries
CREATE INDEX IF NOT EXISTS idx_groups_affects_features ON groups USING GIN (affects_features);

-- Note: first_message_url already exists in classified_threads table (line 22 of 001_initial_schema.sql)
-- The code comment saying "not in schema yet" is incorrect and should be fixed in the code

