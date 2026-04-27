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

## Lost?

1. `project` set correctly?  
2. `DATABASE_URL` and tokens set? See `env.example`.  
3. Skill file: `skills/openrundown/SKILL.md` (full tool & CLI list).  
4. Server logs: run MCP with stderr visible if your client allows it.  

For product behavior, see [README.md](README.md).
