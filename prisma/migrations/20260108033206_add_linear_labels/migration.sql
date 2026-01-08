-- Add linear_labels field to store Linear issue labels in database
-- This avoids fetching labels from Linear API every time we update
-- Labels are stored as a text array (String[])

-- Add linear_labels column to github_issues table
ALTER TABLE "github_issues" 
ADD COLUMN IF NOT EXISTS "linear_labels" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Add linear_labels column to groups table
ALTER TABLE "groups" 
ADD COLUMN IF NOT EXISTS "linear_labels" TEXT[] DEFAULT ARRAY[]::TEXT[];


