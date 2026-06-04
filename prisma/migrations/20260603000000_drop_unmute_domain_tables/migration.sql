-- Drop the unMute (community/channel) domain tables.
--
-- openBriefing was split: all community-signal functionality (Discord/chat
-- ingest, GitHub issue/PR tracking, thread classification, grouping,
-- documentation cache, X/Twitter, PM export) moved to a separate product.
-- These tables and their Prisma models were removed from openBriefing; this
-- migration drops them from the database. Reachable openBriefing tools never
-- referenced these tables, so the drop is safe.
--
-- IF EXISTS keeps the migration idempotent (the local mirror DB had these
-- tables dropped manually before this migration was authored). CASCADE clears
-- the foreign keys that only ever linked rows *within* this dropped set.

DROP TABLE IF EXISTS
  "_GitHubIssueToGitHubPullRequest",
  "thread_issue_matches",
  "issue_thread_matches",
  "thread_embeddings",
  "issue_embeddings",
  "group_embeddings",
  "group_threads",
  "ungrouped_threads",
  "ungrouped_issues",
  "classification_history",
  "classified_threads",
  "groups",
  "github_issues",
  "github_pull_requests",
  "discord_messages",
  "channels",
  "documentation_section_embeddings",
  "documentation_embeddings",
  "documentation_sections",
  "documentation_cache",
  "export_results",
  "x_posts",
  "x_watch_configs"
CASCADE;
