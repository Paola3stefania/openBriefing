#!/usr/bin/env bash
#
# Run a Prisma CLI subcommand against whichever DB OFFLINE_DB selects.
# Used by package.json db:* scripts so `npm run db:migrate` etc. follow the
# same routing rule as the application code.
#
#   OFFLINE_DB=false (default) → DATABASE_URL (Neon / cloud)
#   OFFLINE_DB=true            → MEMORY_MIRROR_DATABASE_URL (local Postgres)
#
# Usage:
#   bash scripts/db-cli.sh migrate deploy
#   bash scripts/db-cli.sh migrate status
#   bash scripts/db-cli.sh generate

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve OFFLINE_DB and MEMORY_MIRROR_DATABASE_URL from the shell env first;
# fall back to grepping .env so this works whether or not the caller pre-loaded
# the file (Prisma will also load .env separately, but it does so AFTER this
# wrapper has already chosen the URL).
read_env() {
  local key="$1"
  local val="${!key:-}"
  if [ -z "$val" ] && [ -f "$ROOT/.env" ]; then
    val="$(grep -E "^${key}=" "$ROOT/.env" | head -1 | cut -d= -f2-)"
  fi
  echo "$val"
}

OFFLINE_DB_VAL="$(read_env OFFLINE_DB)"

if [ "${OFFLINE_DB_VAL:-false}" = "true" ]; then
  LOCAL_URL="$(read_env MEMORY_MIRROR_DATABASE_URL)"
  if [ -n "$LOCAL_URL" ]; then
    export DATABASE_URL="$LOCAL_URL"
    echo "[db-cli] OFFLINE_DB=true — running against local DB" >&2
  else
    echo "[db-cli] OFFLINE_DB=true but MEMORY_MIRROR_DATABASE_URL is unset; using DATABASE_URL anyway." >&2
  fi
else
  echo "[db-cli] OFFLINE_DB=false — running against Neon" >&2
fi

exec npx prisma "$@"
