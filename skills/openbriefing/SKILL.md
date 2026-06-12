---
name: openbriefing
description: Provides project memory, agent sessions, briefings, and code understanding for AI agents via the OpenBriefing MCP server. Use at the start of every conversation to get a briefing on recent decisions, open items, and actionable plan steps. Use during work sessions to record decisions and progress for the next agent. Includes a catalog of MCP tools (grouped) and local npm commands for the openbriefing source repo. Triggers when working on any project with OpenBriefing configured.
---

# OpenBriefing

OpenBriefing gives you persistent memory across sessions. It distills your **past agent sessions, saved memories, and indexed code** into a structured briefing so you never start blind.

> OpenBriefing is the memory + code half of a two-server setup. For outside-world signals — Discord, GitHub issues/PRs, X/Twitter, Linear/PM export — use the companion **unMute** MCP server alongside it. Both key off the same `project` (`owner/repo`).

## Detecting the Project

Every call to `get_agent_briefing`, `get_session_history`, and the session/memory tools needs a `project` parameter. The MCP server runs separately and cannot detect your workspace, so you must detect it yourself:

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
4. **Optional (semantic memory):** Call `search_memory` with a short query and `project`, and `get_recent_memories` with `limit: 5` and `project`. **Always pass `project`** — these tools fall back to the MCP server's CWD-detected project if omitted, which leaks memories across projects sharing the same DB.
5. Use the briefing to understand: recent decisions, open items, `actionable[]` plan steps, codebase notes, and `relatedInsights[]`
6. If a previous session has `open_items`, proactively mention them
7. **Resume active plans**: If the last session has `planSteps` with incomplete steps (pending/in_progress/blocked), show the plan status to the user and offer to continue from where the previous agent left off.
8. **Recover auto-closed sessions**: If the most recent session's summary indicates it was auto-closed (e.g., "Auto-closed: session was never properly ended") and its `filesEdited`, `decisionsMade`, or `openItems` are empty, check if the `lastSession` from the briefing has a `scope`. If it does, mention that the previous session (scope: `<scope>`) was lost without saving progress and ask if there is anything to record before moving on. This prevents silent data loss across agent handoffs.

## During Work Sessions

When doing meaningful work (not just answering questions):

1. Call `start_agent_session` with the scope of work and `project`
   - Example: `scope: ["agent-auth", "mcp-tools"], project: "owner/repo"`
2. Call `update_agent_session` **immediately after each meaningful step** (see auto-save rules below)
3. Call `end_agent_session` when done, recording:
   - `decisions_made`: key decisions with brief reasoning
   - `files_edited`: files that were changed
   - `open_items`: unfinished work the next agent should pick up
   - `plan_steps`: structured plan with step statuses (see below)
   - `summary`: 1-2 sentence description of what was accomplished
   - **`related_insights`**: free-form debrief content that doesn't fit decisions/openItems but should be retrievable later by meaning (e.g., "spec is the source of truth", "gotcha: X is null when Y is true", principles that emerged). Each entry becomes a session-linked memory and surfaces in future briefings via `relatedInsights[]` automatically — use this instead of calling `save_memory` separately.
4. The `end_agent_session` response includes `tokenSavings` + `tokenSavingsNote` — **relay it to the user** (e.g. "Session saved — future agents get ~12k tokens of context compressed into a ~1.9k-token briefing (6:1), saving ~10k tokens every session start").

## Saving memories (ad-hoc)

- After an architectural decision, you can call `save_memory` with `project`, the reasoning, and `tags` (e.g. `["area", "decision"]`).
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

The next agent's briefing will include these steps via `actionable[]`, so they know exactly where to pick up.

## Auto-Save on Every Turn (mandatory)

Sessions can be lost at any time (chat disconnects, crashes, timeouts). Since you cannot detect when a chat is about to end, you must save at the end of every turn:

1. **At the end of each response**, after all tool calls and edits are done, call `update_agent_session` with the current cumulative state: `files_edited`, `decisions_made`, `open_items`, `plan_steps` (if a plan exists), and a `summary` of progress so far.
2. This is the **only** required save point – do not call `update_agent_session` after every individual action.
3. `end_agent_session` is still preferred when you know the work is done, but the per-turn save ensures nothing is lost if the chat drops unexpectedly.
4. **First turn rule**: Even if your first response is just a greeting or briefing summary, call `update_agent_session` with at least a `summary` (e.g., "Session started, briefing reviewed. Waiting for user direction."). An empty session that gets auto-closed is useless to the next agent.

## If a tool response contains `embeddingProviderWarning` (mandatory)

`get_agent_briefing`, `save_memory`, `search_memory`, and `end_agent_session` include an `embeddingProviderWarning` field when the embedding provider (Ollama by default) is unreachable. When you see it:

1. **Tell the user immediately**: ask them to start Ollama (open the Ollama app or run `ollama serve`). Until then, semantic memory search degrades to keyword matching, `relatedInsights[]` comes back empty, and new memories are saved **without** embeddings.
2. **Keep working** — nothing is lost. Memory/session text is always persisted; only the vectors are missing.
3. **No manual recovery needed**: once Ollama is back, the server automatically backfills the missing embeddings on the next briefing/memory call (`npm run backfill:memory-embeddings` still exists for manual/bulk runs).

## What Makes a Good Session Record

- Decisions should include the "why", not just the "what"
- Open items should be specific and actionable
- Summaries should be useful to a future agent with no prior context

## How to use this catalog

- **MCP** tools run through your OpenBriefing MCP server. Full JSON schemas and descriptions live in the tool picker; the tables below are a **map** of names and purpose.
- **`npm` scripts** apply when you are working in the **openbriefing source repository** and need to build, test, or manage the database without the MCP.

## Local CLI (openbriefing source repo only)

| Command | Purpose |
|---------|---------|
| `npm run build` | `prisma generate` + `migrate deploy` + `tsc` |
| `npm test` | Run Vitest unit tests |
| `npm run briefing` | Local preview of `get_agent_briefing` output in the terminal (`-- --json`, `-- --scope <area>`) |
| `npm run db:migrate` | `prisma migrate deploy` (respects `OFFLINE_DB`) |
| `npm run db:setup-local` | Create the local Postgres DB + apply schema |
| `npm run db:sync` | Non-destructive, row-level merge between local and cloud |
| `npm run backfill:memory-embeddings` | Re-embed memories saved while the embedding provider was down |
| `npm run reembed:all` | Recompute stored embeddings |
| `npm run dev` | Start dev entry; MCP server is usually started by Cursor, not this |
| `npm run sync:skill` | After editing **this** skill in `skills/openbriefing/`, copy it to `.cursor/skills/openbriefing/SKILL.md` so both stay in sync |

## Agent memory & project context (MCP)

| Tool | When to use |
|------|-------------|
| `get_agent_briefing` | **Every session start** – distilled context (decisions, open items, codebase notes). Pass `project`. Also exposes `actionable[]` (top incomplete plan steps ranked by status × recency × scope) and `relatedInsights[]` (memories semantically related to your current focus). |
| `get_session_history` | Recent sessions; default is compact. Use `verbose: true` only if you need full detail. |
| `get_session_delta` | Compact diff since a reference point (a session ID or ISO timestamp). Use when resuming after a break — returns only what's new (decisions, completed steps, external refs) at ~200-400 tokens vs `get_session_history`'s ~1k. Pass `project` and `since`. Optional `scope` filter. |
| `start_agent_session` | When beginning substantive work. |
| `update_agent_session` | After each turn / meaningful step (per skill rules). **Soft-end**: also works on already-ended sessions for 24h after `endedAt` (configurable via `OPENBRIEFING_SESSION_AMEND_WINDOW_MS`), so a forgotten debrief can land on the right session instead of in `save_memory`. |
| `end_agent_session` | When the work block is done. Pass `related_insights: string[]` for free-form debrief content — each entry becomes a session-linked memory (tagged `session:<id>`, embedded for semantic retrieval) and surfaces in future briefings' `relatedInsights[]` with `sessionId` set so the next agent can navigate back. Use this instead of calling `save_memory` after `end_agent_session`. |
| `link_external_event` | Bind a typed pointer to an artifact on another surface (Slack thread, Notion page, GitHub PR, Linear issue, file, Discord thread) to the active session — instead of stuffing `"Dan ratified X in Slack <url>"` into open_items as a string. The reference is structured and the next agent can navigate it. Resolves the active session as the most-recent amendable session for `project`, or pass `session_id` explicitly. |
| `import_claude_plans` | Import plans from `~/.claude/plans/`. |
| `save_memory` / `search_memory` / `get_recent_memories` / `delete_memory` | Ad-hoc memory not tied to a session. **Always pass `project`** — `project` is the primary param, `project_id` is a deprecated alias. |

## Code understanding (MCP)

| Tool | When to use |
|------|-------------|
| `index_codebase` | Index code from `LOCAL_REPO_PATH` / `GITHUB_REPO_URL` for a search query, so feature/code notes appear in briefings. |
| `index_code_for_features` | Index code mapped to product features. |
| `analyze_code_ownership` / `view_feature_ownership` | Who owns code / which code backs a feature. |
| `investigate_issue` | Investigate a specific issue against the indexed code (on-demand GitHub read of your own repo). |
| `learn_from_pr` / `seed_pr_learnings` | Learn patterns from merged PRs in your own repo. |

## Need channel signals?

Discord, GitHub issue/PR sync, X/Twitter, and Linear/PM export are **not** part of OpenBriefing. Run the companion **unMute** MCP server for those — it shares the same `project` key, so an agent can combine a unMute channel view with an OpenBriefing briefing in the same conversation.
