---
name: openbriefing
description: Provides project context and session memory for AI agents via the OpenBriefing MCP server. Use at the start of every conversation to get a briefing on active issues, recent decisions, and open items. Use during work sessions to record decisions and progress for the next agent. Includes a catalog of MCP tools (grouped) and local npm commands for the openbriefing source repo. Triggers when working on any project with OpenBriefing configured.
---

# OpenBriefing

OpenBriefing gives you persistent memory across sessions. It distills signals from Discord, GitHub, X/Twitter, and past agent sessions into structured briefings so you never start blind.

## Detecting the Project

Every call to `get_agent_briefing`, `get_session_history`, and `start_agent_session` needs a `project` parameter. The MCP server runs separately and cannot detect your workspace, so you must detect it yourself:

1. Run `git remote get-url origin` in the workspace and parse `owner/repo` from the URL
2. If there is no git remote, use the workspace folder name (e.g., `my-project`)
3. Always pass the result as the `project` argument

## At Session Start

Always do this before responding to the user:

1. Detect the project identifier (see above)
2. Call `get_agent_briefing` from the `user-openbriefing` MCP server (or whatever your Cursor MCP entry is named) with `project`
   - Optionally pass `scope` if you know what area the user is working on
   - Optionally pass `since` with the last session timestamp
3. Call `get_session_history` with `limit: 3` and `project` to see recent sessions
4. **Optional (semantic memory):** Call `search_memory` with a short query and `project`, and `get_recent_memories` with `limit: 5` and `project`, if the deployment uses the memory tools. **Always pass `project`** — these tools fall back to the MCP server's CWD-detected project if omitted, which leaks memories across projects sharing the same DB.
5. Use the briefing to understand: active issues, recent decisions, open items, active plans, user signals, tech signals from X/Twitter
6. If a previous session has `open_items`, proactively mention them
7. **Resume active plans**: If the last session has `planSteps` with incomplete steps (pending/in_progress/blocked), show the plan status to the user and offer to continue from where the previous agent left off.
8. **Recover auto-closed sessions**: If the most recent session's summary indicates it was auto-closed (e.g., "Auto-closed: session was never properly ended") and its `filesEdited`, `decisionsMade`, or `openItems` are empty, check if the `lastSession` from the briefing has a `scope`. If it does, mention to the user that the previous session (scope: `<scope>`) was lost without saving progress and ask if there is anything to record before moving on. This prevents silent data loss across agent handoffs.

## During Work Sessions

When doing meaningful work (not just answering questions):

1. Call `start_agent_session` with the scope of work and `project`
   - Example: `scope: ["agent-auth", "mcp-tools"], project: "owner/repo"`
2. Call `update_agent_session` **immediately after each meaningful step** (see auto-save rules below)
3. Call `end_agent_session` when done, recording:
   - `decisions_made`: key decisions with brief reasoning
   - `files_edited`: files that were changed
   - `open_items`: unfinished work the next agent should pick up
   - `issues_referenced`: GitHub issue numbers discussed
   - `plan_steps`: structured plan with step statuses (see below)
   - `summary`: 1-2 sentence description of what was accomplished
   - **`related_insights`**: free-form debrief content that doesn't fit decisions/openItems but should be retrievable later by meaning (e.g., "spec is the source of truth", "gotcha: X is null when Y is true", principles that emerged). Each entry becomes a session-linked memory and surfaces in future briefings via `relatedInsights[]` automatically — use this instead of calling `save_memory` separately.

## Saving memories (ad-hoc)

- After an architectural decision, you can call `save_memory` with `project`, the reasoning, and `tags` (e.g. `["area", "decision"]`) if your deployment has embeddings configured.
- Non-obvious codebase facts are good candidates to save.
- **Always pass `project`** to `save_memory` / `search_memory` / `get_recent_memories`. They accept `project` (preferred) or the legacy `project_id` alias. If both are omitted, the tools fall back to the MCP server's CWD-detected project — which produces silent cross-project leaks when one DB is shared across multiple repos.

## Saving Plans (mandatory when plans exist)

When you create a plan (in Plan mode, or outline implementation steps), you **must** persist it via `plan_steps` so the next agent can continue:

1. **When creating a plan**: Convert each step into a `plan_steps` entry with `id`, `description`, and `status: "pending"`. Save immediately via `update_agent_session`.
2. **As you complete steps**: Update the step's status to `"completed"` (or `"blocked"` with a `notes` explaining why). Include the full `plan_steps` array with updated statuses in your `update_agent_session` call.
3. **Plan step statuses**: `pending`, `in_progress`, `completed`, `blocked`
4. **At session end**: The final `plan_steps` state should reflect what was done and what remains. Incomplete steps are automatically visible to the next agent via the briefing.

Example `plan_steps`:

```json
[
  { "id": "1", "description": "Add planSteps field to schema", "status": "completed" },
  { "id": "2", "description": "Update session CRUD", "status": "completed" },
  { "id": "3", "description": "Update MCP handlers", "status": "in_progress" },
  { "id": "4", "description": "Write tests", "status": "pending" }
]
```

The next agent's briefing will include these steps, so they know exactly where to pick up.

## Auto-Save on Every Turn (mandatory)

Sessions can be lost at any time (chat disconnects, crashes, timeouts). Since you cannot detect when a chat is about to end, you must save at the end of every turn:

1. **At the end of each response**, after all tool calls and edits are done, call `update_agent_session` with the current cumulative state: `files_edited`, `decisions_made`, `open_items`, `plan_steps` (if a plan exists), and a `summary` of progress so far.
2. This is the **only** required save point – do not call `update_agent_session` after every individual action.
3. `end_agent_session` is still preferred when you know the work is done, but the per-turn save ensures nothing is lost if the chat drops unexpectedly.
4. **First turn rule**: Even if your first response is just a greeting or briefing summary, call `update_agent_session` with at least a `summary` (e.g., "Session started, briefing reviewed. Waiting for user direction."). An empty session that gets auto-closed is useless to the next agent.

## What Makes a Good Session Record

- Decisions should include the "why", not just the "what"
- Open items should be specific and actionable
- Summaries should be useful to a future agent with no prior context

## How to use this catalog

- **MCP** tools run through your OpenBriefing MCP server. Full JSON schemas and descriptions live in the tool picker; the tables below are a **map** of names and purpose.
- **`npm` scripts** apply when you are working in the **openbriefing source repository** and need to build, test, or sync data to Postgres without the MCP.

## Local CLI (openbriefing source repo only)

| Command | Purpose |
|---------|---------|
| `npm run build` | `prisma generate` + `migrate deploy` + `tsc` |
| `npm test` | Run Vitest unit tests |
| `npm run sync:all` | Pull latest **GitHub issues** + **Discord** default channel into the DB (same as MCP `fetch_github_issues` + `fetch_discord_messages` when `DATABASE_URL` is set; incremental by default) |
| `npm run sync:all -- --full` | Full re-fetch/upsert for both (heavy) |
| `npm run sync:all -- --github-only` or `--discord-only` | One side only |
| `npm run fetch-issues` / `fetch-issues-incremental` | JSON cache of issues (not the primary path when the DB is configured) |
| `npm run fetch-discord` | JSON cache of messages (not the primary path when the DB is configured) |
| `npm run briefing` | Local preview of `get_agent_briefing` output in the terminal |
| `npm run dev` | Start dev entry; MCP server is usually started by Cursor, not this |
| `npm run sync:skill` | After editing **this** skill in `skills/openbriefing/`, copy it to `.cursor/skills/openbriefing/SKILL.md` so both stay in sync |

## Agent memory & project context (MCP)

| Tool | When to use |
|------|-------------|
| `get_agent_briefing` | **Every session start** – distilled context (issues, decisions, sessions, signals). Pass `project`. Also exposes `actionable[]` (top incomplete plan steps ranked by recency × scope match) and `relatedInsights[]` (memories semantically related to your current focus). |
| `get_session_history` | Recent sessions; default is compact. Use `verbose: true` only if you need full detail. |
| `get_session_delta` | Compact diff since a reference point (a session ID or ISO timestamp). Use when resuming after a break — returns only what's new (decisions, completed steps, external refs) at ~200-400 tokens vs `get_session_history`'s ~1k. Pass `project` and `since`. Optional `scope` filter. |
| `start_agent_session` | When beginning substantive work. |
| `update_agent_session` | After each turn / meaningful step (per skill rules). **Soft-end**: also works on already-ended sessions for 24h after `endedAt` (configurable via `OPENBRIEFING_SESSION_AMEND_WINDOW_MS`), so a forgotten debrief can land on the right session instead of in `save_memory`. |
| `end_agent_session` | When the work block is done. Pass `related_insights: string[]` for free-form debrief content — each entry becomes a session-linked memory (tagged `session:<id>`, embedded for semantic retrieval) and surfaces in future briefings' `relatedInsights[]` with `sessionId` set so the next agent can navigate back. Use this instead of calling `save_memory` after `end_agent_session`. |
| `link_external_event` | Bind a typed pointer to an artifact on another surface (Slack thread, Notion page, GitHub PR, Linear issue, file, Discord thread) to the active session — instead of stuffing `"Dan ratified X in Slack <url>"` into open_items as a string. The reference is structured (channel/ts/repo/number/...) and the next agent can navigate it. Resolves the active session as the most-recent amendable session for `project`, or pass `session_id` explicitly. |
| `import_claude_plans` | Import plans from `~/.claude/plans/`. |
| `save_memory` / `search_memory` / `get_recent_memories` / `delete_memory` | Ad-hoc memory not tied to a session. **Always pass `project`** — `project` is the primary param, `project_id` is a deprecated alias. |

## GitHub & Discord: fetch and search (MCP)

| Tool | When to use |
|------|-------------|
| `fetch_github_issues` | Sync issues from GitHub into storage (DB or JSON, depending on env). Supports incremental. |
| `check_github_issues_completeness` | Diagnostics on coverage vs API. |
| `fetch_discord_messages` | Sync a channel to storage (DB preferred when configured). |
| `search_github_issues` | Query stored issues. |
| `read_messages` / `search_messages` / `list_channels` / `list_servers` | Read/search Discord in context of the running bot. |
| `search_discord_and_github` | Unified search across both. |

## Classification, grouping, embeddings (MCP)

| Tool | When to use |
|------|-------------|
| `classify_discord_messages` | Classify threads; may also refresh GitHub context first. **Fast-path:** pass `skip_github_sync: true` and `skip_embeddings: true` for a quick `limit:N` classification using whatever's already in the DB. Each stage emits `[stage] ... → start / ← ok / ✕ TIMEOUT` logs on stderr; per-stage timeouts are env-tunable (see `env.example`). |
| `check_discord_classification_completeness` | Gaps in classification. |
| `group_github_issues` / `suggest_grouping` | Correlation / grouping of issues. |
| `match_*` (`match_groups_to_features`, `match_ungrouped_issues_to_features`, `match_issues_to_features`, `match_database_groups_to_features`, `match_issues_to_threads`) | Map issues/groups/threads to features. |
| `label_github_issues` | Suggest/apply labels from stored data. |
| `compute_*_embeddings` (`compute_discord_embeddings`, `compute_github_issue_embeddings`, `compute_feature_embeddings`, `compute_group_embeddings`) | Backfill or refresh vector embeddings. |

## End-to-end workflows: sync → export (MCP)

| Tool | When to use |
|------|-------------|
| `sync_classify_and_export` | **Issue-centric pipeline**: sync GitHub + (expects Discord in DB) embeddings, group, and export. Needs DB + `OPENAI_API_KEY`. |
| `export_to_pm_tool` | Export grouped work to the configured PM (e.g. Linear). |
| `validate_pm_setup` / `list_linear_teams` | Check PM connection and teams. |
| `validate_export_sync` / `export_stats` | Reconcile PM vs local DB, stats. |
| `remove_linear_duplicates` | Cleanup in Linear. |

## Linear and GitHub ↔ Linear (MCP)

| Tool | When to use |
|------|-------------|
| `sync_combined` | PR-based + comment + Linear status in one go. |
| `sync_pr_based_status` / `sync_linear_status` / `sync_engineer_comments` | Individual steps. |
| `audit_and_fix_incorrectly_assigned` | Fix false-positive Linear states from old syncs. |
| `classify_linear_issues` / `label_linear_issues` | Label/structure Linear issues. |

## Code, docs, ownership, learning (MCP)

| Tool | When to use |
|------|-------------|
| `index_codebase` / `index_code_for_features` | Code search index for the repo. |
| `manage_documentation_cache` | PM/docs fetch cache. |
| `analyze_code_ownership` / `view_feature_ownership` | Ownership and features. |
| `seed_pr_learnings` / `learn_from_pr` / `investigate_issue` / `open_pr_with_fix` / `fix_github_issue` | Learning and automated fix flows. |

## X (Twitter) (MCP)

| Tool | When to use |
|------|-------------|
| `fetch_x_posts` | Ingest from X. |
| `manage_x_watches` | Subscriptions. |
| `search_x_posts` | Search ingested posts. |

## External chat ingest (Slack, Teams, Telegram, ... via any MCP)

| Tool | When to use |
|------|-------------|
| `ingest_chat_messages` | Persist normalized chat messages from **any** external MCP into OpenBriefing's generic chat store. The agent maps the source's payload into `{source, workspace_id, channel_id, messages[]}` and OpenBriefing handles ID prefixing (`<source>:<workspace_id>:...`) so multiple sources share one DB. The returned `workspaceKey` is what to add to **`PROJECT_CHAT_WORKSPACES`** for per-project briefing scope. After ingest, the same classification / grouping / embedding pipelines work unchanged. Requires `DATABASE_URL`. |

Project scoping for shared databases is controlled by two merged env vars:
- `PROJECT_CHAT_WORKSPACES` (preferred, source-agnostic) — values are prefixed workspace IDs (e.g. `slack:T01ABC`, `teams:tenant-x`).
- `PROJECT_DISCORD_GUILDS` (legacy, Discord-only) — values are bare Discord guild snowflakes.
