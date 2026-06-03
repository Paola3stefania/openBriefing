#!/usr/bin/env bash
#
# Push local Postgres state up to Neon. The reverse of seed-local-from-neon.sh.
#
# Use this when you've worked offline against the local mirror (`DATABASE_URL`
# pointed at localhost) and want to upload that day's work to Neon.
#
# DESTRUCTIVE: overwrites Neon's `public` schema with local state.
#   - Every public table on Neon is truncated and re-loaded from the local
#     dump.
#   - If another machine wrote to Neon while you were offline, those writes
#     are lost.
#   - Pass --force to skip the confirmation prompt.
#
# Why it has to be destructive: Neon's free tier doesn't grant superuser, so
# `pg_restore --disable-triggers` fails. To load data without FK violations
# we drop every FK on Neon, TRUNCATE the tables, COPY the rows, and re-add
# the FKs. This means partial / merge-style sync isn't supported here — if
# you want safer concurrency, run `db:seed-local-from-neon` first to pull
# down anything new from Neon, then run this to push back up.
#
# Usage:
#   bash scripts/sync-local-to-neon.sh           # interactive confirm
#   bash scripts/sync-local-to-neon.sh --force   # for cron / scripts
#
# Prereqs:
#   - DATABASE_URL or NEON_DATABASE_URL in .env points at the Neon target.
#   - Local DB at postgresql://$USER@localhost:5432/briefings is the source.
#   - postgresql@17 client tools on PATH.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FORCE=0
LOCAL_DB_NAME="${LOCAL_DB_NAME:-briefings}"
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    *) LOCAL_DB_NAME="$arg" ;;
  esac
done

PG_USER="${PGUSER:-$(whoami)}"

# Local URL: prefer MEMORY_MIRROR_DATABASE_URL from .env (same value the app
# uses), fall back to building one from $LOCAL_DB_NAME and the current user.
LOCAL_URL="$(grep -E '^MEMORY_MIRROR_DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2-)"
if [ -z "${LOCAL_URL:-}" ]; then
  LOCAL_URL="postgresql://${PG_USER}@localhost:5432/${LOCAL_DB_NAME}"
fi

# Prefer @17 brew install for tool-version match with Neon (Postgres 17).
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

fail() { echo "[sync-local-to-neon] ERROR: $1" >&2; exit 1; }

# --- 1. Prereqs ------------------------------------------------------------
[ -f .env ] || fail ".env not found at repo root."

# Neon target is always DATABASE_URL — that var holds the cloud URL whether
# OFFLINE_DB=true or false (the toggle picks which DB the *app* uses; this
# script always pushes to Neon regardless).
NEON_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
[ -n "$NEON_URL" ] || fail "DATABASE_URL not set in .env."

# Sanity: bail loudly if we'd push to localhost — that's a no-op at best,
# data-corrupting at worst.
case "$NEON_URL" in
  *localhost*|*127.0.0.1*|*"@$(hostname)"*)
    fail "Target URL points at localhost. Set NEON_DATABASE_URL in .env to the Neon URL."
    ;;
esac

command -v "$PG_DUMP"    >/dev/null 2>&1 || fail "$PG_DUMP not found. Install: brew install postgresql@17"
command -v "$PG_RESTORE" >/dev/null 2>&1 || fail "$PG_RESTORE not found."
command -v "$PSQL"       >/dev/null 2>&1 || fail "$PSQL not found."

if ! "$PSQL" "$LOCAL_URL" -tAc 'SELECT 1' >/dev/null 2>&1; then
  fail "Cannot connect to local DB at $LOCAL_URL."
fi

if ! "$PSQL" "$NEON_URL" -tAc 'SELECT 1' >/dev/null 2>&1; then
  fail "Cannot connect to Neon target. Check internet + NEON_DATABASE_URL."
fi

# --- 2. Confirm (unless --force) -------------------------------------------
if [ "$FORCE" -ne 1 ]; then
  echo
  echo "  This will REPLACE every row in Neon's public schema with local data."
  echo "  Local source: $LOCAL_URL"
  echo "  Neon target:  $(echo "$NEON_URL" | sed -E 's|://[^@]+@|://***@|')"
  echo
  read -r -p "  Continue? [y/N] " ans
  case "$ans" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 0 ;; esac
fi

# --- 3. Dump local (parallel, custom format, data-only) --------------------
DUMP_DIR="/tmp/local-sync-$$.dumpdir"
trap 'rm -rf "$DUMP_DIR"' EXIT

echo "[sync-local-to-neon] Dumping local public schema → $DUMP_DIR..."
"$PG_DUMP" "$LOCAL_URL" \
  --format=directory \
  --jobs=4 \
  --data-only \
  --schema=public \
  --exclude-table='_prisma_migrations' \
  --no-owner \
  --no-privileges \
  --file="$DUMP_DIR" 2>&1 | tail -5

DUMP_SIZE=$(du -sh "$DUMP_DIR" | cut -f1)
echo "[sync-local-to-neon] Dump size: $DUMP_SIZE"

# --- 4. Capture Neon's FKs, drop them, truncate, restore, re-add -----------
FK_DROP=/tmp/sync-fk-drop-$$.sql
FK_ADD=/tmp/sync-fk-add-$$.sql
trap 'rm -rf "$DUMP_DIR" "$FK_DROP" "$FK_ADD"' EXIT

echo "[sync-local-to-neon] Capturing FK definitions on Neon..."
"$PSQL" "$NEON_URL" -tAc "
SELECT 'ALTER TABLE ' || conrelid::regclass || ' DROP CONSTRAINT ' || quote_ident(conname) || ';'
FROM pg_constraint
WHERE contype = 'f' AND connamespace = 'public'::regnamespace
ORDER BY conrelid::regclass::text
" > "$FK_DROP"

"$PSQL" "$NEON_URL" -tAc "
SELECT 'ALTER TABLE ' || conrelid::regclass || ' ADD CONSTRAINT ' || quote_ident(conname) || ' ' || pg_get_constraintdef(oid) || ';'
FROM pg_constraint
WHERE contype = 'f' AND connamespace = 'public'::regnamespace
ORDER BY conrelid::regclass::text
" > "$FK_ADD"

FK_COUNT=$(wc -l < "$FK_DROP" | tr -d ' ')
echo "[sync-local-to-neon] $FK_COUNT FKs captured."

echo "[sync-local-to-neon] Dropping FKs on Neon..."
"$PSQL" "$NEON_URL" -v ON_ERROR_STOP=1 -f "$FK_DROP" >/dev/null

echo "[sync-local-to-neon] Truncating Neon's public tables (preserving _prisma_migrations)..."
"$PSQL" "$NEON_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  LOOP
    EXECUTE format('TRUNCATE TABLE %I CASCADE', r.tablename);
  END LOOP;
END$$;
SQL

echo "[sync-local-to-neon] Restoring local dump to Neon (parallel)..."
"$PG_RESTORE" \
  --dbname="$NEON_URL" \
  --jobs=4 \
  --data-only \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "$DUMP_DIR" 2>&1 | tail -10

echo "[sync-local-to-neon] Re-adding FKs on Neon..."
"$PSQL" "$NEON_URL" -v ON_ERROR_STOP=1 -f "$FK_ADD" >/dev/null

# --- 5. Verify -------------------------------------------------------------
"$PSQL" "$NEON_URL" -c "ANALYZE" >/dev/null 2>&1 || true

LOCAL_TOTAL=$("$PSQL" "$LOCAL_URL" -tAc "
DO \$\$
DECLARE r RECORD; total BIGINT := 0; c BIGINT;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename != '_prisma_migrations'
  LOOP EXECUTE format('SELECT count(*) FROM %I', r.tablename) INTO c; total := total + c; END LOOP;
  RAISE NOTICE 'total: %', total;
END\$\$;
" 2>&1 | grep -oE '[0-9]+' | tail -1)

NEON_TOTAL=$("$PSQL" "$NEON_URL" -tAc "
DO \$\$
DECLARE r RECORD; total BIGINT := 0; c BIGINT;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename != '_prisma_migrations'
  LOOP EXECUTE format('SELECT count(*) FROM %I', r.tablename) INTO c; total := total + c; END LOOP;
  RAISE NOTICE 'total: %', total;
END\$\$;
" 2>&1 | grep -oE '[0-9]+' | tail -1)

echo
echo "  Local total rows: $LOCAL_TOTAL"
echo "  Neon  total rows: $NEON_TOTAL"
if [ "$LOCAL_TOTAL" = "$NEON_TOTAL" ]; then
  echo
  echo "[sync-local-to-neon] ✅ Local → Neon sync complete. Row counts match."
else
  echo
  echo "[sync-local-to-neon] ⚠️  Row count mismatch. Inspect the restore log above."
  exit 1
fi
