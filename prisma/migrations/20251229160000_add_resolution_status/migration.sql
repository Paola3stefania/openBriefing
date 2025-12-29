-- Add resolution status tracking to classified_threads
-- Tracks if a thread is resolved even if the associated GitHub issue is still open
ALTER TABLE "classified_threads" 
ADD COLUMN IF NOT EXISTS "resolution_status" TEXT,
ADD COLUMN IF NOT EXISTS "resolved_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "classified_threads_resolution_status_idx" ON "classified_threads"("resolution_status");

-- Add resolution status tracking to ungrouped_threads
ALTER TABLE "ungrouped_threads" 
ADD COLUMN IF NOT EXISTS "resolution_status" TEXT,
ADD COLUMN IF NOT EXISTS "resolved_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ungrouped_threads_resolution_status_idx" ON "ungrouped_threads"("resolution_status");

-- Add comments
COMMENT ON COLUMN "classified_threads"."resolution_status" IS 'Resolution status: conversation_resolved (thread resolved via conversation analysis), or null (not resolved)';
COMMENT ON COLUMN "ungrouped_threads"."resolution_status" IS 'Resolution status: closed_issue (top issue is closed), conversation_resolved (thread resolved via conversation analysis), or null (not resolved/closed)';

