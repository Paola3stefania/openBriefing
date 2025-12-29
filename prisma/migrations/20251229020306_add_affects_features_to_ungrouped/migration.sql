-- Add affects_features column to ungrouped_threads table
ALTER TABLE "ungrouped_threads" 
ADD COLUMN IF NOT EXISTS "affects_features" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Add GIN index for efficient JSON queries on affects_features
CREATE INDEX IF NOT EXISTS "ungrouped_threads_affects_features_idx" 
ON "ungrouped_threads" USING GIN ("affects_features");

-- Add affects_features column to ungrouped_issues table
ALTER TABLE "ungrouped_issues" 
ADD COLUMN IF NOT EXISTS "affects_features" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Add GIN index for efficient JSON queries on affects_features
CREATE INDEX IF NOT EXISTS "ungrouped_issues_affects_features_idx" 
ON "ungrouped_issues" USING GIN ("affects_features");
