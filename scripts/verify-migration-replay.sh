#!/usr/bin/env bash
#
# Replay the entire migration chain into a throwaway database and assert the
# resulting schema shape.
#
# Why this exists: every other check in this repo runs against an
# already-migrated database, so a migration that can only fail on a *fresh*
# chain is invisible to them. That is exactly how a backdated timestamp
# (20260603000000_drop_unmute_domain_tables, authored after the two migrations
# that sort after it) shipped a chain that no new contributor could apply.
#
# Usage:
#   bash scripts/verify-migration-replay.sh
#
# Environment:
#   REPLAY_ADMIN_URL  Connection URL for a maintenance database used only to
#                     CREATE/DROP the scratch database.
#                     Default: postgresql://$PGUSER-or-$USER@localhost:5432/postgres
#                     The username must be spelled out in the URL: Prisma's
#                     connector does not fall back to PGUSER the way libpq does,
#                     and a userless URL fails with P1010.
#   REPLAY_DB_NAME    Scratch database name. Default: openbriefing_replay_check.
#   REPLAY_KEEP_DB    Set to 1 to keep the scratch database for inspection.
#
# The scratch database is dropped on exit unless REPLAY_KEEP_DB=1. The server
# must have the `vector` extension available; the chain creates it itself in
# 20260602000000_memory_pgvector.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for tool in psql python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[replay] '$tool' is required but not on PATH." >&2
    echo "[replay]   macOS:  brew install postgresql@17" >&2
    echo "[replay]   Debian: apt-get install -y postgresql-client python3" >&2
    exit 1
  fi
done

ADMIN_URL="${REPLAY_ADMIN_URL:-postgresql://${PGUSER:-$USER}@localhost:5432/postgres}"
DB_NAME="${REPLAY_DB_NAME:-openbriefing_replay_check}"

PSQL_QUIET=(-qtAX --set=ON_ERROR_STOP=1)

# Server-side setting, so it has to travel via PGOPTIONS rather than psql's
# --set (which only defines psql variables). Silences the "does not exist,
# skipping" notice from the pre-emptive DROP DATABASE.
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

# Swap the database path of the admin URL for the scratch database, preserving
# credentials, host, port and query string (sslmode etc.).
scratch_url() {
  python3 - "$ADMIN_URL" "$DB_NAME" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit

url, db = sys.argv[1], sys.argv[2]
parts = urlsplit(url)
print(urlunsplit(parts._replace(path=f"/{db}")))
PY
}

SCRATCH_URL="$(scratch_url)"

cleanup() {
  if [ "${REPLAY_KEEP_DB:-0}" = "1" ]; then
    echo "[replay] keeping scratch database '$DB_NAME' (REPLAY_KEEP_DB=1)"
    echo "[replay]   $SCRATCH_URL"
    return
  fi
  psql "$ADMIN_URL" "${PSQL_QUIET[@]}" -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[replay] creating scratch database '$DB_NAME'"
psql "$ADMIN_URL" "${PSQL_QUIET[@]}" -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE);" >/dev/null
psql "$ADMIN_URL" "${PSQL_QUIET[@]}" -c "CREATE DATABASE \"$DB_NAME\";" >/dev/null

echo "[replay] applying $(find prisma/migrations -name migration.sql | wc -l | tr -d ' ') migrations from empty"
# An explicit DATABASE_URL in the environment wins over any .env Prisma loads,
# so a developer's local .env can't redirect this at a real database.
DATABASE_URL="$SCRATCH_URL" npx prisma migrate deploy --schema prisma/schema.prisma

failures=0
fail() {
  echo "[replay] FAIL: $1" >&2
  failures=$((failures + 1))
}

q() { psql "$SCRATCH_URL" "${PSQL_QUIET[@]}" -c "$1"; }

# Every embedding column that survives the chain must be halfvec(1024) — the
# Ollama mxbai-embed-large dimension set by 20260603100000.
for table in code_file_embeddings code_section_embeddings feature_embeddings \
             memory_entry_embeddings pr_learnings; do
  # to_regclass, not ::regclass — the cast raises 42P01 on a missing table,
  # which under `set -e` would abort with a raw psql error instead of the
  # readable assertion below. to_regclass returns NULL, so the row just misses.
  actual="$(q "SELECT format_type(atttypid, atttypmod) FROM pg_attribute
                WHERE attrelid = to_regclass('$table') AND attname = 'embedding';")"
  if [ "$actual" != "halfvec(1024)" ]; then
    fail "$table.embedding is '${actual:-<missing>}', expected halfvec(1024)"
  fi
  index="${table}_embedding_hnsw"
  if [ "$(q "SELECT count(*) FROM pg_indexes WHERE indexname = '$index';")" != "1" ]; then
    fail "missing HNSW index $index"
  fi
done

# Tables owned by unMute must not survive 20260603000000_drop_unmute_domain_tables.
for table in issue_embeddings thread_embeddings group_embeddings \
             documentation_embeddings documentation_section_embeddings \
             github_issues github_pull_requests discord_messages channels \
             groups x_posts x_watch_configs export_results; do
  if [ "$(q "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = '$table';")" != "0" ]; then
    fail "unMute table '$table' still exists after the drop migration"
  fi
done

if [ "$failures" -ne 0 ]; then
  echo "[replay] $failures assertion(s) failed" >&2
  exit 1
fi

echo "[replay] OK — chain replays from empty and the schema shape is as expected"
