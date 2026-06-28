-- Add project_id column to code_searches for multi-project scoping
-- (mirrors 20260219000000_add_project_id_to_agent_sessions). Existing rows
-- default to 'default'; new manual indexes tag the resolved project id
-- (owner/repo or folder name, e.g. 'better-auth/idp').
ALTER TABLE "code_searches" ADD COLUMN "project_id" TEXT NOT NULL DEFAULT 'default';

-- Index for efficient per-project code-search lookups.
CREATE INDEX "code_searches_project_id_idx" ON "code_searches"("project_id");
