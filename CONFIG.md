# Configuration Guide

OpenBriefing is configured via environment variables. Create a `.env` file in the project root (copy `env.example`) or set them in your shell. For the full reference see [docs/ENVIRONMENT_VARIABLES.md](docs/ENVIRONMENT_VARIABLES.md).

> OpenBriefing covers memory, sessions, briefings, and code. Channel config (Discord/GitHub-sync/X/Linear tokens) lives in the companion **unMute** project, not here.

## Required

### Database (no JSON fallback)
PostgreSQL is mandatory — the server throws on startup if it's unset.
- `DATABASE_URL` — connection string, e.g. `postgresql://user:password@localhost:5432/briefings`
- OR the individual vars: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- `STORAGE_BACKEND` — defaults to `database`. `json` is honored **only** under `NODE_ENV=test`.

### Embeddings (for memory search + code index)
- Default provider is **Ollama** (local): `OLLAMA_BASE_URL` (default `http://localhost:11434`), `OLLAMA_EMBEDDING_MODEL` (e.g. `mxbai-embed-large`).
- To use OpenAI instead: `EMBEDDING_PROVIDER=openai` + `OPENAI_API_KEY` (+ optional `OPENAI_EMBEDDING_MODEL`).
- `EMBEDDING_DIM` must match the model's output dimension.

## Optional

### Code understanding
- `LOCAL_REPO_PATH` — absolute path to the repo to index (preferred, faster).
- `GITHUB_REPO_URL` — fallback source for `index_codebase` when no local path.
- `GITHUB_TOKEN` — lets `investigate_issue` / `learn_from_pr` read issues/PRs from your own repo (higher rate limits).

### Two-mode database (offline toggle)
- `OFFLINE_DB` — `false` (default) routes Prisma at `DATABASE_URL` (cloud/Neon); `true` routes at `MEMORY_MIRROR_DATABASE_URL` (local Postgres).
- `MEMORY_MIRROR_DATABASE_URL` — when set, every `save_memory` also dual-writes the row + embedding to this second DB (best-effort; failures never fail the primary). Auto-disabled when the active DB is the mirror.

### Sessions
- `OPENBRIEFING_SESSION_AMEND_WINDOW_MS` — how long after `endedAt` an ended session can still be amended via `update_agent_session` (default 24h).

## Example `.env`

```env
# Database (REQUIRED — Postgres, no JSON fallback)
DATABASE_URL=postgresql://user:password@localhost:5432/briefings

# Embeddings (Ollama by default)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_EMBEDDING_MODEL=mxbai-embed-large
EMBEDDING_DIM=1024
# To use OpenAI instead:
# EMBEDDING_PROVIDER=openai
# OPENAI_API_KEY=sk-...

# Code understanding (optional)
# LOCAL_REPO_PATH=/Users/you/projects/your-repo
# GITHUB_REPO_URL=https://github.com/owner/repo
# GITHUB_TOKEN=ghp_...

# Two-mode DB (optional)
# OFFLINE_DB=false
# MEMORY_MIRROR_DATABASE_URL=postgresql://you@localhost:5432/briefings
```

## Configuration priority

1. Environment variables (highest priority)
2. Default values (fallback)

Config is loaded at runtime, so you can override defaults without modifying code.
