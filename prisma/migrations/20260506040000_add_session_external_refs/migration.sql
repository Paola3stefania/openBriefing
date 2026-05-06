-- Add typed external references column to agent_sessions.
-- Populated by the `link_external_event` MCP tool to bind structured pointers
-- (slack threads, notion pages, github PRs, file paths, ...) to a session
-- instead of stuffing them into openItems as searchable strings.
--
-- Default '[]' so existing rows read as an empty list without a backfill.
ALTER TABLE "agent_sessions"
  ADD COLUMN "external_refs" JSONB NOT NULL DEFAULT '[]'::jsonb;
