# AGENTS.md — for humans, coding agents, and any LLM using this repository

This file is the **onboarding map** for the [OpenBriefing](https://github.com/Paola3stefania/openBriefing) codebase. Read it first when you have no prior context.

## What you are looking at

OpenBriefing is a **Node.js (TypeScript) MCP server** that gives AI agents **project memory, sessions, briefings, and code understanding**:

- **Sessions** — `start/update/end_agent_session`, plus `link_external_event` and `import_claude_plans`
- **Memory** — `save_memory` / `search_memory` (pgvector semantic search) / `get_recent_memories` / `delete_memory`
- **Briefings** — `get_agent_briefing` distills sessions + memory + code into a ~300-500 token payload
- **Code understanding** — `index_codebase`, `index_code_for_features`, `analyze_code_ownership`, `view_feature_ownership`, `investigate_issue`, `learn_from_pr`, `seed_pr_learnings`

The MCP entrypoint is `src/index.ts` → `src/mcp/server.ts`.

> **Two-server split.** OpenBriefing is the memory + code half. Outside-world signals — Discord, GitHub issue/PR sync, X/Twitter, Linear/PM export — live in the companion **[unMute](https://github.com/Paola3stefania/unMute)** MCP server. They share the same `project` (`owner/repo`) key and run side by side; an agent can call both. Do **not** add channel/ingest/export features here.

## Read order (shortest path to competence)

1. **This file** (you are here).
2. **`.cursor/skills/openbriefing/SKILL.md`** — *same content as* **`skills/openbriefing/SKILL.md`** (the latter is what `scripts/setup.ts` copies into *consumer* projects). Session protocol, `project` parameter, tool catalog, local `npm` commands.
3. **`env.example`** — required and optional environment variables (never commit a real `.env`).

Deeper reference:

| Doc | Use when |
|-----|----------|
| [docs/ENVIRONMENT_VARIABLES.md](docs/ENVIRONMENT_VARIABLES.md) | Full env reference |
| [docs/DATABASE_SETUP.md](docs/DATABASE_SETUP.md) | Postgres + Prisma |
| [docs/GITHUB_INTEGRATION.md](docs/GITHUB_INTEGRATION.md) | GitHub token for `investigate_issue` / `learn_from_pr` + code fetch |
| [docs/INSTALL.md](docs/INSTALL.md) | Install from scratch |
| [README.md](README.md) | User-facing product overview |

## Non-negotiable: the `project` parameter

The MCP process **does not** know the user's workspace. Every `get_agent_briefing`, `get_session_history`, and session/memory call needs an explicit `project` string, usually `owner/repo` from `git remote get-url origin` or the folder name. Wrong `project` → wrong or empty briefing when multiple projects share one database. This is also the key that lines OpenBriefing up with unMute for the same repo.

## Repository layout (maintenance view)

| Path | Role |
|------|------|
| `src/mcp/server.ts` | Tool definitions and handlers (briefing/session/memory/code) |
| `src/briefing/` | Briefing distillation (`distill.ts`, `projectScope.ts`, `sessions.ts`) — **code + sessions + memory only** |
| `src/learning/` | `investigate_issue`, `learn_from_pr`, `seed_pr_learnings` |
| `src/connectors/github/` | On-demand GitHub reads (issue/PR for investigate/learn) + code fetchers |
| `src/analysis/` | Code ownership |
| `src/embeddings/` | Embedding wrappers (`embed.ts`, `semantic.ts`) — Ollama by default, OpenAI optional |
| `src/storage/` | Prisma storage (sessions, memory, code index), caches, vector IO |
| `prisma/` | Schema and migrations |
| `scripts/` | CLI: `briefing.ts`, `setup.ts`, `db-*`, `reembed-all.ts`, etc. |
| `skills/openbriefing/SKILL.md` | **Distributable** agent skill (copied by `setup.ts`) |
| `rules/openbriefing.mdc` | **Distributable** Cursor rule (session protocol) |
| `hooks/hooks.json` | Optional Cursor hooks (copied by `setup`) |

`*.test.ts` under `src/**` is excluded from the production `tsc` build; tests run with Vitest.

## Commands you will actually use (in this repo)

```bash
npm install
npm run build   # prisma generate, migrate deploy, tsc
npm test        # vitest
```

Database (respects the `OFFLINE_DB` toggle — see below):

```bash
npm run db:setup-local            # create local Postgres DB + apply schema
npm run db:migrate                # prisma migrate deploy
npm run db:seed-local-from-neon   # clone cloud data into local
npm run db:sync                   # non-destructive row-level merge (db-merge.sh)
```

Preview the briefing in the terminal:

```bash
npm run briefing
npm run briefing -- --json
npm run briefing -- --scope auth
```

Recover memories saved while the embedding provider was broken (rows land without an embedding, so semantic search can't surface them):

```bash
npm run backfill:memory-embeddings -- --dry-run
npm run backfill:memory-embeddings
```

**Install OpenBriefing into another project** (copies skill, rule, hooks, writes `.cursor/mcp.json`):

```bash
npx tsx scripts/setup.ts /path/to/target
```

## MCP server name in Cursor

Your Cursor config may name the server `user-openbriefing`, `openbriefing`, or another label. The **tool names** (`get_agent_briefing`, `save_memory`, `index_codebase`, …) are stable; the **server name** is whatever is in the user's MCP config.

## Security and secrets

- Never commit **`.env`**, API keys, or PEM paths.
- `env.example` and docs use placeholders only.

## Contributing (agents included)

- Prefer **small, focused PRs**; keep tests passing (`npm test`).
- After changing briefing or distillation logic, add or extend tests in `src/**/*.test.ts` when behavior is testable.
- If you change **`skills/openbriefing/SKILL.md`**, run **`npm run sync:skill`** so **`.cursor/skills/openbriefing/SKILL.md`** stays identical (distributable source of truth is `skills/`; `setup.ts` copies from there).
- Keep channel/ingest/PM-export features out of this repo — they belong to [unMute](https://github.com/Paola3stefania/unMute).

## Mental model (one picture)

```text
 Past agent sessions ──┐
 Saved memories ───────┼──► OpenBriefing MCP ──► get_agent_briefing, session/memory/code tools
 Indexed code ─────────┘ ▲
                         │
        start/update/end_agent_session, save_memory, index_codebase
```

## Data flow: what hits the database

### Storage backend is mandatory

There is no local-JSON fallback: if `DATABASE_URL`/`DB_*` is unset the server throws on startup (`src/storage/factory.ts`). `STORAGE_BACKEND=json` is honored only under `NODE_ENV=test`. Use a local Postgres for dev or a cloud Postgres (Neon/Supabase/Vercel) to share the brain.

### What fills the DB (all agent-authored via tools)

- **Sessions** — `agent_sessions` rows from `start/update/end_agent_session`. `update_agent_session` accepts ended sessions for `OPENBRIEFING_SESSION_AMEND_WINDOW_MS` (default 24h) after `endedAt`, so a forgotten debrief can still land on the right record.
- **Memory** — `memory_entries` + `memory_entry_embeddings`. `end_agent_session({ related_insights })` writes session-linked memories (`source: "session"`, `sessionId` set) — the canonical way to debrief, instead of a separate `save_memory` call.
- **Code** — `index_codebase` / `index_code_for_features` read `LOCAL_REPO_PATH` (preferred) or `GITHUB_REPO_URL`, chunk + embed, and store `CodeSearch`/`CodeFile`/`CodeSection`/`Feature`/`FeatureCodeMapping`. `investigate_issue` / `learn_from_pr` do **on-demand** reads of a specific issue/PR via `src/connectors/github` — a single fetch, not a bulk sync.

### Agent memory uses `pgvector`

`memory_entry_embeddings.embedding` is a real `vector`/`halfvec` column with an HNSW cosine index (migration `20260602000000_memory_pgvector`). Prisma maps it as `Unsupported`, so it's read/written via raw SQL only — see `src/storage/db/vector.ts`, the raw upsert in `src/storage/db/memory.ts`, and the indexed `<=>` search in `searchMemory` + `distillRelatedInsights`. Apply with `npm run db:migrate` (deploy); do **not** `migrate dev` against it. The other embedding tables (code/features) are still JSONB + JS cosine.

### The `OFFLINE_DB` toggle (two-mode architecture)

`OFFLINE_DB` routes the Prisma client (`src/storage/db/prisma.ts`):

- `OFFLINE_DB=false` → `DATABASE_URL` (cloud/Neon)
- `OFFLINE_DB=true` → `MEMORY_MIRROR_DATABASE_URL` (local Postgres)

**Optional local mirror (dual-write).** Set `MEMORY_MIRROR_DATABASE_URL` and every `saveMemory` writes the row + embedding to that second DB too (`src/storage/db/mirror.ts`). Best-effort (mirror failure never fails the primary), embeds once for both, and nulls the `sessionId` FK in the mirror when the session isn't present there. The mirror auto-disables when the active DB *is* the mirror. For point-in-time snapshots instead of live mirroring, use `npm run db:backup` (`scripts/backup-db.sh`).

### `db:sync` is a non-destructive merge

`npm run db:sync` (`scripts/db-merge.sh`) does a row-level, newest-wins merge between local and cloud using `INSERT ... ON CONFLICT DO UPDATE` through binary `COPY` staging tables — it never wipes either side.

### `get_agent_briefing` derived fields

- **`actionable[]`** — top incomplete plan steps from recent sessions, ranked by status × recency × scope match. The next agent's "what should I pick up first?" queue.
- **`relatedInsights[]`** — memories semantically related to the current focus (scope + plan steps + open items). Requires an embedding provider for the focus-query embedding; falls back to `[]` silently otherwise. When `source === "session"` and `sessionId` is set, fetch the full session via `get_session_history({ session_id, verbose: true })`.
- `activeIssues` is now session-derived (open items / plan steps), and `userSignals` / `techSignals` come back empty — channel signals live in unMute.

### One shared database, many `project` IDs

If many projects share one DB, the `project` string (usually `owner/repo` from git) keeps every session/memory/code query scoped. Keep it consistent across calls.

## Lost?

1. `project` set correctly?
2. `DATABASE_URL` set and an embedding provider reachable (Ollama running, or `OPENAI_API_KEY`)? See `env.example`.
3. Skill file: `skills/openbriefing/SKILL.md` (full tool & CLI list).
4. Need channel signals (Discord/GitHub/X/Linear)? That's [unMute](https://github.com/Paola3stefania/unMute), not this repo.

For product behavior, see [README.md](README.md).
