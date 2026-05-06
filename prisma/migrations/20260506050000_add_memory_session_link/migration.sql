-- Link memory entries back to the session that authored them, when one exists.
-- Populated by `end_agent_session({ related_insights: [...] })` and any future
-- automated ingestion path. Nullable because manual `save_memory` calls and
-- imported context have no originating session. `ON DELETE SET NULL` so
-- removing a session doesn't destroy the insights it produced.

ALTER TABLE "memory_entries"
  ADD COLUMN "session_id" TEXT;

ALTER TABLE "memory_entries"
  ADD CONSTRAINT "memory_entries_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "memory_entries_session_id_idx" ON "memory_entries"("session_id");
