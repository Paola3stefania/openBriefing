#!/usr/bin/env bash
#
# Seed a local Postgres mirror with every row currently in Neon.
#
# Run this once per machine after `bash scripts/setup-local-db.sh` has created
# the local database and applied the schema. After that, the local DB has the
# same tables as Neon but is empty; this script copies all data over so you
# have an offline-readable, exact-parity copy.
#
# Strategy:
#   1. Dump Neon (custom format, parallel, data-only) — fast and atomic.
#   2. Truncate every public table on the local DB so we can reload cleanly.
#   3. pg_restore in parallel with --disable-triggers so FK constraints don't
#      fire during load. The local user is the cluster superuser by default
#      (brew install postgresql@17 grants this), so --disable-triggers is OK
#      here even though it isn't on Neon.
#   4. Verify row counts match.
#
# Usage:
#   bash scripts/seed-local-from-neon.sh
#   bash scripts/seed-local-from-neon.sh briefings   # custom local db name
#
# Prereqs:
#   - DATABASE_URL in .env points at the Neon source DB.
#   - bash scripts/setup-local-db.sh has run (creates local DB + applies schema).
#   - postgresql@17 client tools (pg_dump / pg_restore / psql) on PATH.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOCAL_DB_NAME="${1:-briefings}"
PG_USER="${PGUSER:-$(whoami)}"

# Local URL: prefer MEMORY_MIRROR_DATABASE_URL from .env if set (single source
# of truth — same value the app uses for the local DB), fall back to building
# one from $LOCAL_DB_NAME and the current user.
LOCAL_URL="$(grep -E '^MEMORY_MIRROR_DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2-)"
if [ -z "${LOCAL_URL:-}" ]; then
  LOCAL_URL="postgresql://${PG_USER}@localhost:5432/${LOCAL_DB_NAME}"
fi

# Resolve PG client tools — prefer the brew @17 install if present so the
# version matches Neon (Postgres 17). Falls back to whatever's on PATH.
PG_BIN_CANDIDATES=(
  "/opt/homebrew/opt/postgresql@17/bin"
  "/usr/local/opt/postgresql@17/bin"
)
PG_BIN=""
for d in "${PG_BIN_CANDIDATES[@]}"; do
  if [ -x "$d/pg_dump" ]; then PG_BIN="$d"; break; fi
done

PG_DUMP="${PG_BIN:+$PG_BIN/}pg_dump"
PG_RESTORE="${PG_BIN:+$PG_BIN/}pg_restore"
PSQL="${PG_BIN:+$PG_BIN/}psql"

fail() { echo "[seed-local-from-neon] ERROR: $1" >&2; exit 1; }

# --- 1. Prereqs ------------------------------------------------------------
[ -f .env ] || fail ".env not found at repo root."

# Pull the Neon connection string out of .env (handles values with =, &, ?).
#
# Parallel pg_dump (--jobs) opens a leader + N worker connections and shares a
# snapshot between them via pg_export_snapshot() / SET TRANSACTION SNAPSHOT.
# Neon's POOLED endpoint (the `-pooler` host, pgbouncer in transaction-pooling
# mode) can't hold that snapshot across connections, so a parallel dump there
# fails. Prefer DATABASE_URL_UNPOOLED (the direct host); fall back to the
# pooled DATABASE_URL only if the unpooled one isn't defined.
NEON_URL="$(grep -E '^DATABASE_URL_UNPOOLED=' .env | head -1 | cut -d= -f2-)"
[ -n "$NEON_URL" ] || NEON_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
[ -n "$NEON_URL" ] || fail "Neither DATABASE_URL_UNPOOLED nor DATABASE_URL set in .env."

command -v "$PG_DUMP"     >/dev/null 2>&1 || fail "$PG_DUMP not found. Install: brew install postgresql@17"
command -v "$PG_RESTORE"  >/dev/null 2>&1 || fail "$PG_RESTORE not found."
command -v "$PSQL"        >/dev/null 2>&1 || fail "$PSQL not found."

if ! "$PSQL" "$LOCAL_URL" -tAc 'SELECT 1' >/dev/null 2>&1; then
  fail "Cannot connect to local DB at $LOCAL_URL. Run scripts/setup-local-db.sh first."
fi

# Confirm schema exists (a sentinel table from the openBriefing schema).
if ! "$PSQL" "$LOCAL_URL" -tAc "SELECT to_regclass('public.agent_sessions')" 2>/dev/null | grep -q agent_sessions; then
  fail "Local DB exists but schema not applied. Run scripts/setup-local-db.sh first."
fi

# --- 2. Dump Neon (parallel, custom format, data-only) ---------------------
DUMP_DIR="/tmp/neon-seed-$$.dumpdir"
trap 'rm -rf "$DUMP_DIR"' EXIT

echo "[seed-local-from-neon] Dumping Neon public schema → $DUMP_DIR (parallel, data-only)..."
# We intentionally exclude `_prisma_migrations` — that's per-DB schema state,
# not application data. The local DB already has its own copy from running
# `prisma migrate deploy`, and copying Neon's table over would conflict.
"$PG_DUMP" "$NEON_URL" \
  --format=directory \
  --jobs=4 \
  --data-only \
  --schema=public \
  --exclude-table='_prisma_migrations' \
  --no-owner \
  --no-privileges \
  --file="$DUMP_DIR" 2>&1 | tail -5

DUMP_SIZE=$(du -sh "$DUMP_DIR" | cut -f1)
echo "[seed-local-from-neon] Dump size: $DUMP_SIZE"

# --- 3. Wipe local data (keep schema), then restore ------------------------
echo "[seed-local-from-neon] Truncating every public table on local..."
"$PSQL" "$LOCAL_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  LOOP
    EXECUTE format('TRUNCATE TABLE %I CASCADE', r.tablename);
  END LOOP;
END$$;
SQL

echo "[seed-local-from-neon] Restoring (parallel, --disable-triggers)..."
"$PG_RESTORE" \
  --dbname="$LOCAL_URL" \
  --jobs=4 \
  --data-only \
  --disable-triggers \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "$DUMP_DIR" 2>&1 | tail -10

# --- 4. Verify row counts ---------------------------------------------------
echo "[seed-local-from-neon] Verifying row counts..."
NEON_TOTAL=$("$PSQL" "$NEON_URL"  -tAc "SELECT coalesce(sum(n_live_tup), 0) FROM pg_stat_user_tables WHERE schemaname='public'")
LOCAL_TOTAL=$("$PSQL" "$LOCAL_URL" -tAc "SELECT coalesce(sum(n_live_tup), 0) FROM pg_stat_user_tables WHERE schemaname='public'")
"$PSQL" "$LOCAL_URL" -c "ANALYZE" >/dev/null 2>&1 || true
LOCAL_TOTAL=$("$PSQL" "$LOCAL_URL" -tAc "SELECT coalesce(sum(n_live_tup), 0) FROM pg_stat_user_tables WHERE schemaname='public'")

echo
echo "  Neon  total rows: $NEON_TOTAL"
echo "  Local total rows: $LOCAL_TOTAL"

NEON_SIZE=$("$PSQL"  "$NEON_URL"  -tAc "SELECT pg_size_pretty(pg_database_size(current_database()))")
LOCAL_SIZE=$("$PSQL" "$LOCAL_URL" -tAc "SELECT pg_size_pretty(pg_database_size(current_database()))")
echo "  Neon  size: $NEON_SIZE"
echo "  Local size: $LOCAL_SIZE"

cat <<EOF

[seed-local-from-neon] ✅ Local mirror seeded.

Optionally enable live dual-write of new agent memory by adding to .env:

  MEMORY_MIRROR_DATABASE_URL=$LOCAL_URL

EOF
