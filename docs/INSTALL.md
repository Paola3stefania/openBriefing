# Installing OpenBriefing from scratch

Technical, end-to-end setup on a fresh machine. The **default path is a local
Postgres** (fully offline, free, no cloud account). A cloud (Neon) path is
documented as an alternative, plus how to run **both** and keep them in sync.

For a non-technical, click-by-click version, see
[CLAUDE_DESKTOP_SETUP.md](CLAUDE_DESKTOP_SETUP.md).

---

## 1. Requirements

Three things are **required**; everything else is optional.

| Component | Version | Purpose | Notes |
|-----------|---------|---------|-------|
| **Node.js** | 18+ | Runs the MCP server / CLI | `npm` ships with it |
| **Postgres + pgvector** | 17 | Storage backend (**mandatory**) | No JSON fallback — the server throws on startup if no DB is configured (`src/storage/factory.ts`). `STORAGE_BACKEND=json` is honored only under `NODE_ENV=test`. |
| **Ollama + 2 models** | latest | Local embeddings + chat | Default provider. No API key, no per-token cost. |

> **Why Postgres is required:** agent memory uses `pgvector` (`halfvec(1024)`
> columns with an HNSW cosine index). Embeddings, briefings, and session history
> all read/write the DB.

### macOS install of the requirements

```bash
# Node
brew install node

# Postgres 17 + pgvector, started as a background service
brew install postgresql@17 pgvector
brew services start postgresql@17

# Ollama + the two default models
brew install --cask ollama-app
open -a Ollama
ollama pull mxbai-embed-large   # embeddings, 1024-dim (~670 MB)
ollama pull qwen2.5:14b         # chat / classification / extraction
```

> Keep Ollama running (it lives in the menu bar). If it isn't running, every
> embed/chat call throws with a clear error rather than silently degrading.

---

## 2. Get the code

```bash
git clone https://github.com/Paola3stefania/openBriefing.git
cd openBriefing
npm install
```

---

## 3. Configure `.env`

```bash
cp env.example .env
```

Edit `.env`. **Minimum for the default local + Ollama stack:**

```bash
# --- Storage ---
# The local Postgres lives in MEMORY_MIRROR_DATABASE_URL (this is also the URL
# db:setup-local and db:sync use as "local"). DATABASE_URL is the cloud/Neon DB
# used when OFFLINE_DB=false; for pure-local you can point it at the same local URL.
MEMORY_MIRROR_DATABASE_URL=postgresql://YOUR_MACOS_USER@localhost:5432/briefings
DATABASE_URL=postgresql://YOUR_MACOS_USER@localhost:5432/briefings

# --- REQUIRED to actually use the local DB ---
# The app routes to DATABASE_URL (cloud) by DEFAULT. You MUST set this flag to
# make it read/write the LOCAL Postgres (MEMORY_MIRROR_DATABASE_URL). The flag is
# read once at startup — restart the MCP server / Cursor / Claude after changing it.
OFFLINE_DB=true

# --- Brain: local Ollama (default) ---
EMBEDDING_PROVIDER=ollama
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_EMBEDDING_MODEL=mxbai-embed-large
OLLAMA_CHAT_MODEL=qwen2.5:14b
```

Find `YOUR_MACOS_USER` with `whoami`. (Homebrew Postgres creates a superuser role
matching your macOS username with no password by default.)

> **⚠️ The `OFFLINE_DB=true` flag is the part everyone forgets.** Without it, the
> app ignores your local DB and talks to `DATABASE_URL` (cloud). With two-mode
> setups: `OFFLINE_DB=true` → local, `OFFLINE_DB=false` → cloud. See
> [AGENTS.md](../AGENTS.md) ("Two-mode architecture") for the full picture.

Optional integrations — add only what you use (full list in
[ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md)):

```bash
# Code understanding (index_codebase / investigate_issue / learn_from_pr)
LOCAL_REPO_PATH=/path/to/your/repo   # preferred, faster
GITHUB_REPO_URL=owner/repo           # fallback source + repo to read issues/PRs from
GITHUB_TOKEN=...                     # higher rate limits for issue/PR reads

# Use OpenAI instead of Ollama (must emit 1024-dim embeddings)
# EMBEDDING_PROVIDER=openai
# LLM_PROVIDER=openai
# OPENAI_API_KEY=...
```

> Need Discord / GitHub-issue sync / X / Linear signals? Those live in the
> companion [unMute](https://github.com/Paola3stefania/unMute) MCP server, not here.

---

## 4. Build + create the database

```bash
npm run db:setup-local   # creates the `briefings` DB, enables pgvector, applies schema
npm run build            # prisma generate + prisma migrate deploy + tsc
```

`db:setup-local` (`scripts/setup-local-db.sh`) creates and migrates the **local**
`briefings` DB and is idempotent — safe to re-run.

> **The MCP launcher `run-mcp.sh` is created for you.** Both Cursor and Claude
> Desktop point their `command` at `run-mcp.sh`, which is **gitignored** (each
> machine can tweak `PATH`/node). `npm install` runs a `postinstall` hook
> (`scripts/ensure-launcher.mjs`) that creates it from the committed
> `run-mcp.sh.example` — so a fresh clone gets it automatically. If it's ever
> missing (you'll see `Failed to spawn process: No such file or directory` in the
> client logs), recreate it with **`npm run setup:launcher`**.

> **Heads up — which DB gets migrated:**
> - `npm run db:setup-local` and `npm run db:migrate` go through `scripts/db-cli.sh`,
>   which **honors `OFFLINE_DB`** (true → local `MEMORY_MIRROR_DATABASE_URL`).
> - Plain `npm run build` runs `prisma migrate deploy` directly against
>   **`DATABASE_URL`**, ignoring the flag. So if `DATABASE_URL` is your cloud DB,
>   `build` migrates the cloud; the local DB is handled by `db:setup-local`.
> - Make sure Postgres is running first (`brew services start postgresql@17`).

---

## 5. Verify

```bash
npm run smoke-test       # checks DB routing, Ollama embedding dims, ANN search
npm run briefing         # prints a briefing for the current project to the terminal
```

A clean `smoke-test` and a `briefing` that renders (even if mostly empty on a fresh
DB) means the core is working.

---

## 6. Connect a client

### Cursor
- Copy `cursor-mcp-config.json.example` into your Cursor MCP config and fill in the
  absolute path + any env, **or**
- Auto-install the skill, rule, hooks, and MCP config into a target project:

  ```bash
  npx tsx scripts/setup.ts /path/to/target-project
  ```

### Claude Desktop
- Minimal config at `~/Library/Application Support/Claude/claude_desktop_config.json`:

  ```json
  {
    "mcpServers": {
      "OpenBriefing": {
        "command": "/ABSOLUTE/PATH/TO/openBriefing/run-mcp.sh"
      }
    }
  }
  ```
- `run-mcp.sh` `cd`s into the repo, loads `.env`, and resolves `node` even under the
  minimal PATH the desktop apps use. Full walkthrough:
  [CLAUDE_DESKTOP_SETUP.md](CLAUDE_DESKTOP_SETUP.md).

---

## Alternative: cloud (Neon) instead of local

Use this when you want a shared "brain" across machines.

1. Create a Postgres database on Neon (or Supabase/Vercel Postgres) with the
   `vector` extension available.
2. In `.env`, point `DATABASE_URL` at the cloud connection string (keep the Ollama
   block — the brain stays local even when the DB is in the cloud):

   ```bash
   DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
   # Neon: also set the direct (unpooled) host for migrations + dumps:
   DATABASE_URL_UNPOOLED=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
   ```
3. `npm run build` applies migrations to the cloud DB. Skip `db:setup-local`.

If many projects share one cloud DB, the `project` (`owner/repo`) key keeps every
session/memory/code query scoped — keep it consistent across calls.

---

## Alternative: both (local primary + Neon), kept in sync

Run local-first for speed/offline, with Neon as the shared copy. This is the
two-mode (`OFFLINE_DB`) architecture — full details in
[AGENTS.md](../AGENTS.md) ("Two-mode architecture").

- `.env`: set `DATABASE_URL` (Neon) **and** `MEMORY_MIRROR_DATABASE_URL` (local).
- `OFFLINE_DB=false` → app uses Neon; `OFFLINE_DB=true` → app uses local. The flag
  is read once at startup, so restart after changing it.
- Keep the two aligned with the **non-destructive merge** (insert-missing +
  update-if-newer, nothing deleted):

  ```bash
  npm run db:sync -- down --dry-run   # preview Neon -> local
  npm run db:sync -- down             # pull
  npm run db:sync -- up               # push local -> Neon
  ```

  For a clean rebuild or to propagate deletions, use the destructive
  `npm run db:seed-local-from-neon` / `npm run db:sync-local-to-neon`.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Server throws on startup about storage/DB | `DATABASE_URL` (or `DB_*`) not set, or Postgres not running. `brew services start postgresql@17`. |
| App reads/writes the **cloud** DB when you wanted **local** (or vice-versa) | Set `OFFLINE_DB=true` for local (needs `MEMORY_MIRROR_DATABASE_URL`), `false` for cloud — then **restart** (the flag is read once at startup). Startup logs print `[prisma] active database: local|neon`. |
| `prisma migrate deploy` fails | DB unreachable, or (Neon) you used the pooled host — set `DATABASE_URL_UNPOOLED`. |
| Every embed/chat call throws | Ollama not running (`open -a Ollama`) or models not pulled. |
| Embedding dimension mismatch | Your `OLLAMA_EMBEDDING_MODEL` must emit 1024 dims (or write a new `halfvec(N)` migration + `npm run reembed:all`). |
| `node: command not found` in a client | Use `run-mcp.sh` as the `command` (it fixes PATH); don't point the client straight at `node`. |
| Memories saved but not searchable | They lack embeddings (provider was down). `npm run backfill:memory-embeddings`. |

For the full environment reference see [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md);
for Postgres specifics see [DATABASE_SETUP.md](DATABASE_SETUP.md).
