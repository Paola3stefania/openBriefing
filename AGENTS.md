# AGENTS.md — for humans, coding agents, and any LLM using this repository

This file is the **onboarding map** for the [OpenRundown](https://github.com/Paola3stefania/openRundown) codebase. Read it first when you have no prior context.

## What you are looking at

OpenRundown is a **Node.js (TypeScript) MCP server** that:

- Ingests signals (GitHub, Discord, X/Twitter, agent sessions, optional PM tools)
- **Distills** them into a compact `get_agent_briefing` payload for other agents
- **Persists** session memory (Postgres + Prisma) when configured

The MCP entrypoint is `src/index.ts` → `src/mcp/server.ts` (dozens of tools).

## Read order (shortest path to competence)

1. **This file** (you are here).
2. **`.cursor/skills/openrundown/SKILL.md`** — *same content as* **`skills/openrundown/SKILL.md`** (the latter is what `scripts/setup.ts` copies into *consumer* projects). Session protocol, `project` parameter, tool catalog, local `npm` commands.
3. **`env.example`** — required and optional environment variables (never commit a real `.env`).

Deeper reference:

| Doc | Use when |
|-----|----------|
| [docs/ENVIRONMENT_VARIABLES.md](docs/ENVIRONMENT_VARIABLES.md) | Full env reference |
| [docs/DATABASE_SETUP.md](docs/DATABASE_SETUP.md) | Postgres + Prisma |
| [docs/GITHUB_INTEGRATION.md](docs/GITHUB_INTEGRATION.md) | GitHub App / token |
| [docs/LINEAR_TEAM_SETUP.md](docs/LINEAR_TEAM_SETUP.md) | Linear export |
| [README.md](README.md) | User-facing product overview |

## Non-negotiable: the `project` parameter

The MCP process **does not** know the user’s workspace. Every `get_agent_briefing`, `get_session_history`, and session call needs an explicit `project` string, usually `owner/repo` from `git remote get-url origin` or the folder name. Wrong `project` → wrong or empty briefing when multiple projects share one database.

## Repository layout (maintenance view)

| Path | Role |
|------|------|
| `src/mcp/server.ts` | Tool definitions and handlers (large file) |
| `src/briefing/` | Briefing distillation (`distill.ts`, `projectScope.ts`, sessions) |
| `src/connectors/` | GitHub, Discord, X clients |
| `src/storage/` | Prisma/JSON storage, caches, embeddings |
| `src/sync/` | Linear / PR / comment sync |
| `src/export/` | PM tool export (e.g. Linear) |
| `prisma/` | Schema and migrations |
| `scripts/` | CLI: `briefing.ts`, `setup.ts`, `sync-github-discord.ts`, etc. |
| `skills/openrundown/SKILL.md` | **Distributable** agent skill (copied by `setup.ts`) |
| `rules/openrundown.mdc` | **Distributable** Cursor rule (session protocol) |
| `hooks/hooks.json` | Optional Cursor hooks (copied by `setup`) |

`*.test.ts` under `src/**` is excluded from the production `tsc` build; tests run with Vitest.

## Commands you will actually use (in this repo)

```bash
npm install
npm run build      # prisma generate, migrate deploy, tsc
npm test           # vitest
```

Data sync into **Postgres** (same as MCP `fetch_github_issues` + `fetch_discord_messages` when `DATABASE_URL` is set):

```bash
npm run sync:all
npm run sync:all -- --full           # heavy: full re-fetch/upsert
npm run sync:all -- --github-only
npm run sync:all -- --discord-only
```

Preview the briefing in the terminal:

```bash
npm run briefing
npm run briefing -- --json
```

**Install OpenRundown into another project** (copies skill, rule, hooks, writes `.cursor/mcp.json`):

```bash
npx tsx scripts/setup.ts /path/to/target
```

## MCP server name in Cursor

Your Cursor config may name the server `user-openrundown`, `openrundown`, or another label. The **tool names** (`get_agent_briefing`, `fetch_github_issues`, …) are stable; the **server name** is whatever is in the user’s MCP config.

## Security and secrets

- Never commit **`.env`**, API keys, or PEM paths.
- `env.example` and docs use placeholders only.
- The repository may reference example paths; real keys live on the machine.

## Contributing (agents included)

- Prefer **small, focused PRs**; keep tests passing (`npm test`).
- After changing briefing or distillation logic, add or extend tests in `src/**/*.test.ts` when behavior is testable.
- If you change **`skills/openrundown/SKILL.md`**, run **`npm run sync:skill`** so **`.cursor/skills/openrundown/SKILL.md`** stays identical (distributable source of truth is `skills/`; `setup.ts` copies from there).

## Mental model (one picture)

```text
 GitHub / Discord / X  ─┐
 Past agent sessions  ──┼──►  OpenRundown MCP  ──►  get_agent_briefing, tools
 Postgres (optional)  ──┘         ▲
                                  │
                    start/update/end_agent_session
```

## Data flow: what hits the database vs the network

Use this to reason about **“do we re-fetch every time?”** and **“where do embeddings and classification sit?”**

### When `DATABASE_URL` is set (Postgres + Prisma)

- **GitHub** — Issues (and related fields) are **stored in the DB** (`fetch_github_issues` or `npm run sync:all` with `--github-only`). Later runs are typically **incremental** (new or updated work since the last window), not a full re-download of the entire list every time unless you ask for a full resync.
- **Discord** — Channel messages and channels are **stored in the DB** (`fetch_discord_messages` or `npm run sync:all`). After a first backfill, runs are **incremental** (new/updated messages), not a full history fetch on every run by default.
- **X (Twitter)** — Watches/ingest flows store data for **search and briefing-related signals**; you are not expected to re-hit the live X API for every `get_agent_briefing` if the data is already ingested.
- **Agent sessions and optional PM (e.g. Linear) sync** — **Persisted**; briefing and history tools read from the DB.
- **Other chat sources (Slack, Teams, Telegram, Matrix, Mattermost, ...)** — There is no native fetcher for these in this repo, but the `Channel` + `DiscordMessage` Postgres models are intentionally **generic** (channel id, workspace/team id, author, text, time). Any external MCP can hand off normalized messages via the **`ingest_chat_messages`** tool (see below); the rows then flow through the same classification / grouping / embedding / briefing pipelines as Discord ingest.

### Any external chat MCP via `ingest_chat_messages` (generic)

`ingest_chat_messages` is an MCP tool that accepts a batch of normalized messages from **any** source. The agent (or a custom MCP) is responsible for mapping the source's payload into OpenRundown's normalized shape; OpenRundown handles persistence, ID prefixing, and briefing scoping.

**Input shape (per call):**

```json
{
  "source": "slack",                   // free-form: "slack" | "teams" | "telegram" | ...
  "workspace_id": "T01ABC",            // Slack team id, Teams tenant id, etc.
  "workspace_name": "Acme",            // optional
  "channel_id": "C123",                // native channel id at the source
  "channel_name": "general",           // optional
  "messages": [
    {
      "id": "msg-1",
      "author_id": "U1",
      "author_name": "alice",
      "content": "hello",
      "created_at": "2026-04-27T12:00:00Z",
      "thread_id": "msg-0",            // optional; native parent message id
      "reply_to": "msg-0",             // optional
      "attachments": [{ "id": "f1", "filename": "x.png", "url": "https://...", "size": 42 }],
      "reactions":   [{ "emoji": "+1", "count": 2 }],
      "mentions": ["U2"],
      "url": "https://..."
    }
  ]
}
```

**ID prefixing (automatic).** OpenRundown writes:

| DB column | Stored value |
|---|---|
| `Channel.guildId` | `<source>:<workspace_id>` (e.g. `slack:T01ABC`) |
| `Channel.id`      | `<source>:<workspace_id>:<channel_id>` |
| `DiscordMessage.id`, `threadId`, `messageReference.message_id` | `<source>:<workspace_id>:<channel_id>:<id>` |

This keeps every external source isolated from Discord's bare snowflakes (and from each other) inside a shared database.

**Briefing scoping (per project).** Add the returned `workspaceKey` to **`PROJECT_CHAT_WORKSPACES`** so briefings for that project pick up the new source:

```bash
PROJECT_CHAT_WORKSPACES='{"better-auth/better-auth":["slack:T01ABC","teams:tenant-x"]}'
```

`PROJECT_DISCORD_GUILDS` continues to work for Discord (bare guild ids). The two maps are **merged**: `getProjectChatWorkspaceIds()` returns the union, and the briefing filters all chat-derived signals against it.

**Concept mapping (any source → schema):**

| Concept | DB field | Notes |
|---|---|---|
| Source | (encoded into IDs) | `<source>:` prefix; no schema change. |
| Workspace / team / tenant | `Channel.guildId` | `<source>:<workspace_id>`; matches `PROJECT_CHAT_WORKSPACES`. |
| Room / channel / DM | `Channel.id` | `<source>:<workspace_id>:<channel_id>`. |
| User | `authorId` | Native user id at the source. |
| Text & time | `content`, `createdAt` | ISO 8601 timestamps. |
| Threading | `threadId`, `messageReference` | Replies and threads keep source-scoped IDs. |

After data is stored, the existing **classification, grouping, and embedding** tools work unchanged because they key off `channelId` / thread ids that the ingest path already prefixed.

### `get_agent_briefing` and live APIs

- **`get_agent_briefing` distills from what is already stored** (and session records). It is **not** designed to re-fetch the full GitHub and Discord APIs on every call. Keep data fresh with **periodic** `fetch_*` / `sync:all` / your automation.
- The briefing also exposes two derived fields for handoffs:
  - **`actionable[]`** — top incomplete plan steps from recent sessions, ranked by status × recency × scope match. The next agent's "what should I pick up first?" queue.
  - **`relatedInsights[]`** — memories semantically related to the current focus (scope + plan steps + open items). Reuses `MemoryEntry`/`MemoryEntryEmbedding`, so anything saved with `save_memory` automatically becomes briefing-visible without an extra retrieval call. Requires `OPENAI_API_KEY` for the focus-query embedding; falls back to `[]` silently otherwise.

### Soft-end on `update_agent_session`

- `update_agent_session` accepts ended sessions for `OPENRUNDOWN_SESSION_AMEND_WINDOW_MS` (default 24h) after `endedAt`. This means a forgotten debrief can land on the right session record instead of fragmenting into `save_memory`. After the window expires, the tool returns a clear error pointing at the env var.

### `get_session_delta` and `link_external_event`

- **`get_session_delta(since, scope?, project)`** — compact diff since a reference point (a session ID or ISO timestamp). Returns only what's new (decisions, completed plan steps, new external refs) at ~200-400 tokens vs `get_session_history`'s ~1k. Use when resuming a project after a break.
- **`link_external_event({source, url, text, kind?, ...})`** — bind a typed pointer to an artifact on another surface (Slack thread, Notion page, GitHub PR/issue, Linear issue, file, Discord thread) to the active session. Replaces "stuff a URL into open_items as a string" with structured `ExternalRef` objects the next agent can navigate. By default attaches to the most-recent amendable session for `project`; pass `session_id` to override.

### Classifications and embeddings (for LLMs, but stored in *your* DB)

- **Classification** (e.g. `classify_discord_messages`) is a **separate step** from “fetch.” It reads stored messages, runs the classification pipeline, and **writes** structured results back. Run it when you need new threads classified, or use a chained workflow like `sync_classify_and_export` where the pipeline does multiple steps in order.
- **Embeddings** are **vector representations** (typically via **`OPENAI_API_KEY`**) used for **similarity** (grouping issues, matching threads, etc.). They live in **Postgres** (embedding tables / columns) via tools like `compute_*_embeddings` or inside larger workflows. This is not a second proprietary “LLM database” product — it is **your** database plus embedding fields used by those features.

### One shared database, many `project` IDs (e.g. better-auth repos)

- If many projects share one DB, set **`PROJECT_CHAT_WORKSPACES`** (preferred, source-agnostic) and/or **`PROJECT_DISCORD_GUILDS`** (legacy, Discord-only) — see `env.example`. The two maps are merged, so chat-derived briefing signals **only** include workspaces/guilds mapped to the current `project` ID across every chat source. The `project` string must stay consistent (usually `owner/repo` from `git`).

### `classify_discord_messages` is slow / hanging?

- Every stage now emits `[stage] <name> → start ... ← ok in Nms` (or `✕ TIMEOUT after Nms`) on stderr. Read those logs to see which step is slow: typical culprits are `classify:github-sync` (rate limits / huge comment fetches), `classify:issue-embeddings` and `classify:thread-embeddings` (OpenAI), or `classify:discord-channel-fetch` (hangs forever if the Discord client never logged in).
- Pass **`skip_github_sync: true, skip_embeddings: true`** to bypass the heavy prep work entirely and classify against whatever's already in the DB — this is what makes `limit: 1` actually fast.
- Per-stage and overall timeouts are env-tunable (`OPENRUNDOWN_CLASSIFY_TIMEOUT_MS`, `OPENRUNDOWN_GITHUB_SYNC_TIMEOUT_MS`, ...). The full list is in `env.example`.

## Lost?

1. `project` set correctly?  
2. `DATABASE_URL` and tokens set? See `env.example`.  
3. Skill file: `skills/openrundown/SKILL.md` (full tool & CLI list).  
4. Server logs: run MCP with stderr visible if your client allows it.  

For product behavior, see [README.md](README.md).
