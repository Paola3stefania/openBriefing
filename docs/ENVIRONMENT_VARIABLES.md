# Environment Variables Reference

This document lists all environment variables used by the OpenBriefing MCP Server, organized by category.

> OpenBriefing covers memory, sessions, briefings, and code. Channel variables
> (Discord / GitHub-issue sync / X / Linear) live in the companion
> [unMute](https://github.com/Paola3stefania/unMute) project, not here.

## Required Variables

### Database

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/briefings` |

> **Required**: OpenBriefing stores sessions, agent memory, and the code index in PostgreSQL. There is no JSON fallback — if `DATABASE_URL` (or `DB_*`) is unset the server throws on startup. Use a local Postgres for development or a cloud Postgres (Neon / Supabase / Vercel) to share the brain across machines.

### Embeddings

You need an embedding provider for memory search and the code index. Ollama (local) is the default.

| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_PROVIDER` | Embedding backend: `ollama` (local, default) or `openai` | `ollama` |
| `OLLAMA_BASE_URL` | Ollama server URL | `http://localhost:11434` |
| `OLLAMA_EMBEDDING_MODEL` | Ollama embedding model — must emit 1024-dim vectors | `mxbai-embed-large` |
| `EMBEDDING_DIM` | Embedding dimension; must match the model | `1024` |
| `OPENAI_API_KEY` | Required when `EMBEDDING_PROVIDER=openai` | None |
| `OPENAI_EMBEDDING_MODEL` | OpenAI embedding model (must emit 1024 dims) | `text-embedding-3-small` |

## Optional Variables

### Two-mode database & mirror

| Variable | Description | Default |
|----------|-------------|---------|
| `OFFLINE_DB` | `false` → use `DATABASE_URL`; `true` → use `MEMORY_MIRROR_DATABASE_URL` | `false` |
| `MEMORY_MIRROR_DATABASE_URL` | Second DB that every `save_memory` dual-writes to (best-effort) | None |

### Code understanding

| Variable | Description | Default |
|----------|-------------|---------|
| `LOCAL_REPO_PATH` | Local repo path for `index_codebase` (preferred, faster) | None |
| `GITHUB_REPO_URL` | Repo to index / read issues+PRs from (`owner/repo` or URL) | None |
| `GITHUB_TOKEN` | Token(s) for `investigate_issue` / `learn_from_pr` reads (comma-separated for rotation) | None |
| `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY_PATH` | GitHub App alternative to `GITHUB_TOKEN` (highest rate limits) | None |
| `GITHUB_OWNER` / `GITHUB_REPO` | Auto-extracted from `GITHUB_REPO_URL` if not set | Auto |

### Chat-completion LLM (for code/feature extraction)

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_PROVIDER` | Chat backend: `ollama` or `openai` (falls back to `EMBEDDING_PROVIDER`) | `ollama` |
| `OLLAMA_CHAT_MODEL` | Ollama chat model | `qwen2.5:14b` |
| `OPENAI_CHAT_MODEL` | OpenAI chat model (when `LLM_PROVIDER=openai`) | `gpt-4o-mini` |

> **Default stack is fully local (Ollama).** Set it up once:
>
> ```bash
> brew install --cask ollama-app   # the plain `ollama` formula ships without llama-server
> open -a Ollama                    # starts the server on :11434
> ollama pull mxbai-embed-large     # embeddings (1024-dim)
> ollama pull qwen2.5:14b           # chat / extraction
> ```
>
> To use OpenAI instead, set `EMBEDDING_PROVIDER=openai` and/or `LLM_PROVIDER=openai`
> (plus `OPENAI_API_KEY`). For embeddings, pick an `OPENAI_EMBEDDING_MODEL` that
> emits 1024 dims (or write a new `halfvec(N)` migration + run `npm run reembed:all`).

> **Future embedding upgrade (tracked).** We deliberately stay on
> `mxbai-embed-large` (1024-dim) for now because it's a no-migration default. When
> we want a measurable retrieval-quality jump, switch to **Qwen3-Embedding** (e.g.
> `Qwen3-Embedding-4B`, 2560-dim). It is **not** a drop-in: it requires a new
> `halfvec(2560)` migration on every embedding column, a full `npm run reembed:all`,
> and a local re-seed.

### Sessions

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENBRIEFING_SESSION_AMEND_WINDOW_MS` | How long after `endedAt` an ended session can still be amended | `86400000` (24h) |

## Environment Setup by Use Case

### 1. Minimum (memory + sessions only)

```env
DATABASE_URL=postgresql://you@localhost:5432/briefings
# Ollama running locally provides embeddings by default
```

### 2. With code understanding

```env
DATABASE_URL=postgresql://you@localhost:5432/briefings
LOCAL_REPO_PATH=/path/to/your/repo
GITHUB_REPO_URL=owner/repo
GITHUB_TOKEN=ghp_...
```

### 3. Cloud + local mirror

```env
OFFLINE_DB=false
DATABASE_URL=postgresql://...neon.tech/neondb?sslmode=require
MEMORY_MIRROR_DATABASE_URL=postgresql://you@localhost:5432/briefings
```

## Copy Template

```bash
cp env.example .env
# Then edit .env with your values
```

## Variable Priority

1. **Environment variables** (highest priority)
2. **Default values** (as shown in tables above)
3. **Auto-detection** (e.g., `GITHUB_OWNER`/`GITHUB_REPO` from `GITHUB_REPO_URL`)

## Validation

The system validates required variables at startup. A missing `DATABASE_URL` (or an unreachable embedding provider) will surface a clear error.

## Security Notes

- **Never commit `.env` files** to version control
- **Limit API key permissions** (GitHub tokens should have minimal required scopes)
- **Rotate secrets periodically**
