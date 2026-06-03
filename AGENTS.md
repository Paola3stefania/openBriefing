# AGENTS.md — for humans, coding agents, and any LLM using this repository

This file is the **onboarding map** for the [OpenBriefing](https://github.com/Paola3stefania/openBriefing) codebase. Read it first when you have no prior context.

## What you are looking at

OpenBriefing is a **Node.js (TypeScript) MCP server** that:

- Ingests signals (GitHub, Discord, X/Twitter, agent sessions, optional PM tools)
- **Distills** them into a compact `get_agent_briefing` payload for other agents
- **Persists** session memory (Postgres + Prisma) when configured

The MCP entrypoint is `src/index.ts` → `src/mcp/server.ts` (dozens of tools).

## Read order (shortest path to competence)

1. **This file** (you are here).
2. **`.cursor/skills/openbriefing/SKILL.md`** — *same content as* **`skills/openbriefing/SKILL.md`** (the latter is what `scripts/setup.ts` copies into *consumer* projects). Session protocol, `project` parameter, tool catalog, local `npm` commands.
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
| `skills/openbriefing/SKILL.md` | **Distributable** agent skill (copied by `setup.ts`) |
| `rules/openbriefing.mdc` | **Distributable** Cursor rule (session protocol) |
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

Recover memories that were saved while `OPENAI_API_KEY` was broken/expired (rows land without an embedding row, so semantic search can't surface them):

```bash
npm run backfill:memory-embeddings -- --dry-run
npm run backfill:memory-embeddings
npm run backfill:memory-embeddings -- --project=owner/repo --limit=20
```

**Install OpenBriefing into another project** (copies skill, rule, hooks, writes `.cursor/mcp.json`):

```bash
npx tsx scripts/setup.ts /path/to/target
```

## MCP server name in Cursor

Your Cursor config may name the server `user-openbriefing`, `openbriefing`, or another label. The **tool names** (`get_agent_briefing`, `fetch_github_issues`, …) are stable; the **server name** is whatever is in the user’s MCP config.

## Security and secrets

- Never commit **`.env`**, API keys, or PEM paths.
- `env.example` and docs use placeholders only.
- The repository may reference example paths; real keys live on the machine.

## Contributing (agents included)

- Prefer **small, focused PRs**; keep tests passing (`npm test`).
- After changing briefing or distillation logic, add or extend tests in `src/**/*.test.ts` when behavior is testable.
- If you change **`skills/openbriefing/SKILL.md`**, run **`npm run sync:skill`** so **`.cursor/skills/openbriefing/SKILL.md`** stays identical (distributable source of truth is `skills/`; `setup.ts` copies from there).

## Mental model (one picture)

```text
 GitHub / Discord / X  ─┐
 Past agent sessions  ──┼──►  OpenBriefing MCP  ──►  get_agent_briefing, tools
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

`ingest_chat_messages` is an MCP tool that accepts a batch of normalized messages from **any** source. The agent (or a custom MCP) is responsible for mapping the source's payload into OpenBriefing's normalized shape; OpenBriefing handles persistence, ID prefixing, and briefing scoping.

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

**ID prefixing (automatic).** OpenBriefing writes:

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
  - **`relatedInsights[]`** — memories semantically related to the current focus (scope + plan steps + open items). Reuses `MemoryEntry`/`MemoryEntryEmbedding`, so anything saved with `save_memory` automatically becomes briefing-visible without an extra retrieval call. When `source === "session"` and `sessionId` is set, the entry came from `end_agent_session({ related_insights })` and the next agent can fetch the full session via `get_session_history({ session_id })`. Requires `OPENAI_API_KEY` for the focus-query embedding; falls back to `[]` silently otherwise.

### `end_agent_session.related_insights[]` → session-linked memories

- `end_agent_session` accepts `related_insights: string[]` for free-form debrief content (e.g. "spec is the source of truth", principles that emerged, gotchas worth remembering). Each entry is persisted as a `MemoryEntry` with `source: "session"`, `sessionId` populated, tagged `session`/`session:<id>`, and embedded for semantic retrieval.
- Migration #31 (`20260506050000_add_memory_session_link`) added `MemoryEntry.session_id` as a nullable FK to `agent_sessions(id)` with `ON DELETE SET NULL`. Manual `save_memory` calls leave it `null`; the column is also writable directly from `saveMemory({ sessionId })` for any future automated session-bound ingestion.
- This is the canonical way to debrief — replaces the older pattern of calling `save_memory` after `end_agent_session`, which fragmented the work record across two surfaces with no link between them.

### Soft-end on `update_agent_session`

- `update_agent_session` accepts ended sessions for `OPENBRIEFING_SESSION_AMEND_WINDOW_MS` (default 24h) after `endedAt`. This means a forgotten debrief can land on the right session record instead of fragmenting into `save_memory`. After the window expires, the tool returns a clear error pointing at the env var.

### `get_session_delta` and `link_external_event`

- **`get_session_delta(since, scope?, project)`** — compact diff since a reference point (a session ID or ISO timestamp). Returns only what's new (decisions, completed plan steps, new external refs) at ~200-400 tokens vs `get_session_history`'s ~1k. Use when resuming a project after a break.
- **`link_external_event({source, url, text, kind?, ...})`** — bind a typed pointer to an artifact on another surface (Slack thread, Notion page, GitHub PR/issue, Linear issue, file, Discord thread) to the active session. Replaces "stuff a URL into open_items as a string" with structured `ExternalRef` objects the next agent can navigate. By default attaches to the most-recent amendable session for `project`; pass `session_id` to override.

### Classifications and embeddings (for LLMs, but stored in *your* DB)

- **Classification** (e.g. `classify_discord_messages`) is a **separate step** from “fetch.” It reads stored messages, runs the classification pipeline, and **writes** structured results back. Run it when you need new threads classified, or use a chained workflow like `sync_classify_and_export` where the pipeline does multiple steps in order.
- **Embeddings** are **vector representations** (typically via **`OPENAI_API_KEY`**) used for **similarity** (grouping issues, matching threads, etc.). They live in **Postgres** (embedding tables / columns) via tools like `compute_*_embeddings` or inside larger workflows. This is not a second proprietary “LLM database” product — it is **your** database plus embedding fields used by those features.
  - **Storage backend is now mandatory.** There is no local-JSON fallback: if `DATABASE_URL`/`DB_*` is unset the server throws on startup (`src/storage/factory.ts`). `STORAGE_BACKEND=json` is honored only under `NODE_ENV=test`. Use a local Postgres for dev or a cloud Postgres (Neon/Supabase/Vercel) to share the brain.
  - **Agent memory uses `pgvector`.** `memory_entry_embeddings.embedding` is a real `vector(1536)` column with an HNSW cosine index (migration `20260602000000_memory_pgvector`). Prisma maps `vector` as `Unsupported`, so that column is read/written via raw SQL only — see `src/storage/db/vector.ts`, the raw upsert in `src/storage/db/memory.ts`, and the indexed `<=>` search in `searchMemory` + `distillRelatedInsights`. Apply with `npm run db:migrate` (deploy); do **not** `migrate dev` against it. The other embedding tables (issues/threads/groups/docs/code/features) are still JSONB + JS cosine — converting them is a tracked follow-up (50+ `include:{embedding:true}` call sites).
  - **Optional local mirror (dual-write).** Set `MEMORY_MIRROR_DATABASE_URL` and every `saveMemory` writes the row + embedding to that second DB too (`src/storage/db/mirror.ts`). It's best-effort (mirror failure never fails the primary), embeds once for both, and nulls the `sessionId` FK in the mirror when the session isn't present there. The mirror DB needs the same schema incl. pgvector. For point-in-time snapshots instead of live mirroring, use `npm run db:backup` (`scripts/backup-db.sh`).

### One shared database, many `project` IDs (e.g. better-auth repos)

- If many projects share one DB, set **`PROJECT_CHAT_WORKSPACES`** (preferred, source-agnostic) and/or **`PROJECT_DISCORD_GUILDS`** (legacy, Discord-only) — see `env.example`. The two maps are merged, so chat-derived briefing signals **only** include workspaces/guilds mapped to the current `project` ID across every chat source. The `project` string must stay consistent (usually `owner/repo` from `git`).

### `classify_discord_messages` is slow / hanging?

- Every stage now emits `[stage] <name> → start ... ← ok in Nms` (or `✕ TIMEOUT after Nms`) on stderr. Read those logs to see which step is slow: typical culprits are `classify:github-sync` (rate limits / huge comment fetches), `classify:issue-embeddings` and `classify:thread-embeddings` (OpenAI), or `classify:discord-channel-fetch` (hangs forever if the Discord client never logged in).
- Pass **`skip_github_sync: true, skip_embeddings: true`** to bypass the heavy prep work entirely and classify against whatever's already in the DB — this is what makes `limit: 1` actually fast.
- Per-stage and overall timeouts are env-tunable (`OPENBRIEFING_CLASSIFY_TIMEOUT_MS`, `OPENBRIEFING_GITHUB_SYNC_TIMEOUT_MS`, ...). The full list is in `env.example`.

## Lost?

1. `project` set correctly?  
2. `DATABASE_URL` and tokens set? See `env.example`.  
3. Skill file: `skills/openbriefing/SKILL.md` (full tool & CLI list).  
4. Server logs: run MCP with stderr visible if your client allows it.  

For product behavior, see [README.md](README.md).
