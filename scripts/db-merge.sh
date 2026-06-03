#!/usr/bin/env bash
#
# Non-destructive row-level MERGE between the local Postgres and Neon.
#
# Unlike seed-local-from-neon.sh / sync-local-to-neon.sh (which TRUNCATE the
# destination and reload it wholesale), this script UPSERTS:
#   - rows that don't exist on the destination are INSERTED,
#   - rows that already exist are UPDATED only when the source row is NEWER
#     (newest-wins, by `updated_at`),
#   - everything else is left untouched.
#
# Nothing is ever deleted. So a row present on the destination but absent from
# the source SURVIVES (that's the point — no data loss). If you need to
# propagate deletions or do a clean rebuild, use the full-clobber scripts
# (db:seed-local-from-neon / db:sync-local-to-neon) instead.
#
# How it works (per table), so all Postgres types — halfvec, jsonb, arrays,
# enums — round-trip with zero marshalling:
#   1. CREATE TABLE staging.<t> (LIKE public.<t>) on the destination.
#   2. Binary COPY the source table straight into that staging table
#      (psql \copy ... FORMAT binary | psql \copy ... FORMAT binary).
#   3. INSERT INTO public.<t> SELECT * FROM staging.<t>
#         ON CONFLICT (<pk>) DO UPDATE SET <non-pk cols>=EXCLUDED...
#         WHERE public.<t>.updated_at < EXCLUDED.updated_at   (newest-wins)
#      — or DO NOTHING for tables with no `updated_at` (insert-missing only).
#   4. DROP the staging table.
# FKs on the destination are dropped before and re-added after (Neon's free
# tier has no superuser, so we can't defer them); sequences for autoincrement
# PKs are bumped at the end so future app inserts don't collide.
#
# Usage:
#   bash scripts/db-merge.sh down               # Neon  -> local (pull, merge)
#   bash scripts/db-merge.sh up                 # local -> Neon  (push, merge)
#   bash scripts/db-merge.sh down --dry-run     # show per-table plan, no writes
#   bash scripts/db-merge.sh up   --table=memory_entries
#   bash scripts/db-merge.sh up   --force       # skip the destination backup + confirm
#
# Prereqs:
#   - .env with DATABASE_URL (Neon). DATABASE_URL_UNPOOLED preferred (direct host).
#   - MEMORY_MIRROR_DATABASE_URL (local) — or default postgresql://$USER@localhost:5432/briefings.
#   - postgresql@17 client tools on PATH (pg_dump / psql, matching Neon's PG17).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "[db-merge] ERROR: $1" >&2; exit 1; }

# --- Parse args ------------------------------------------------------------
DIRECTION=""
DRY_RUN=0
FORCE=0
ONLY_TABLE=""
for arg in "$@"; do
  case "$arg" in
    down|up) DIRECTION="$arg" ;;
    --dry-run) DRY_RUN=1 ;;
    --force|-f) FORCE=1 ;;
    --table=*) ONLY_TABLE="${arg#--table=}" ;;
    *) fail "Unknown argument: $arg (expected: down|up [--dry-run] [--force] [--table=NAME])" ;;
  esac
done
[ -n "$DIRECTION" ] || fail "Direction required: 'down' (Neon->local) or 'up' (local->Neon)."
[ -f .env ] || fail ".env not found at repo root."

# --- Resolve URLs ----------------------------------------------------------
read_env() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2-; }

NEON_URL="$(read_env DATABASE_URL_UNPOOLED)"
[ -n "$NEON_URL" ] || NEON_URL="$(read_env DATABASE_URL)"
[ -n "$NEON_URL" ] || fail "Neither DATABASE_URL_UNPOOLED nor DATABASE_URL set in .env."

LOCAL_URL="$(read_env MEMORY_MIRROR_DATABASE_URL)"
[ -n "${LOCAL_URL:-}" ] || LOCAL_URL="postgresql://$(whoami)@localhost:5432/briefings"

# --- PG client tools (match Neon's PG17) -----------------------------------
PG_BIN=""
for d in "/opt/homebrew/opt/postgresql@17/bin" "/usr/local/opt/postgresql@17/bin"; do
  if [ -x "$d/pg_dump" ]; then PG_BIN="$d"; break; fi
done
PG_DUMP="${PG_BIN:+$PG_BIN/}pg_dump"
PSQL="${PG_BIN:+$PG_BIN/}psql"
command -v "$PG_DUMP" >/dev/null 2>&1 || fail "$PG_DUMP not found. Install: brew install postgresql@17"
command -v "$PSQL"    >/dev/null 2>&1 || fail "$PSQL not found."

# --- Source / destination from direction -----------------------------------
if [ "$DIRECTION" = "down" ]; then
  SRC_URL="$NEON_URL";  SRC_LABEL="Neon"
  DST_URL="$LOCAL_URL"; DST_LABEL="local"
else
  SRC_URL="$LOCAL_URL"; SRC_LABEL="local"
  DST_URL="$NEON_URL";  DST_LABEL="Neon"
fi

mask() { echo "$1" | sed -E 's|://[^@]+@|://***@|'; }

echo "[db-merge] Merge (upsert, newest-wins): $SRC_LABEL -> $DST_LABEL"
echo "[db-merge]   source: $(mask "$SRC_URL")"
echo "[db-merge]   dest:   $(mask "$DST_URL")"

"$PSQL" "$SRC_URL" -tAc 'SELECT 1' >/dev/null 2>&1 || fail "Cannot connect to source ($SRC_LABEL)."
"$PSQL" "$DST_URL" -tAc 'SELECT 1' >/dev/null 2>&1 || fail "Cannot connect to dest ($DST_LABEL)."

# psql helpers bound to each side. `q` = quiet scalar query.
src_q() { "$PSQL" "$SRC_URL" -X -tAc "$1"; }
dst_q() { "$PSQL" "$DST_URL" -X -tAc "$1"; }

# --- Table list (from source) ----------------------------------------------
if [ -n "$ONLY_TABLE" ]; then
  TABLES="$ONLY_TABLE"
else
  TABLES="$(src_q "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename")"
fi
[ -n "$TABLES" ] || fail "No tables found on source."

# --- Per-table metadata (computed from the DEST catalog) -------------------
# Comma-joined identifier list of all non-generated columns, in attnum order.
cols_of()    { dst_q "SELECT string_agg(quote_ident(attname), ',' ORDER BY attnum) FROM pg_attribute WHERE attrelid='public.\"$1\"'::regclass AND attnum>0 AND NOT attisdropped AND attgenerated=''"; }
# Conflict-target columns: prefer the PK; fall back to the columns of the
# narrowest UNIQUE index (covers Prisma implicit M:N join tables like
# `_GitHubIssueToGitHubPullRequest`, which have a unique index but no PK).
pk_of()      { dst_q "
WITH pk AS (
  SELECT string_agg(quote_ident(a.attname), ',' ORDER BY k.ord) AS cols
  FROM pg_constraint c
  JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum,ord) ON true
  JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
  WHERE c.conrelid='public.\"$1\"'::regclass AND c.contype='p'
),
uq AS (
  SELECT string_agg(quote_ident(a.attname), ',' ORDER BY k.ord) AS cols
  FROM (SELECT indrelid, indkey FROM pg_index
        WHERE indrelid='public.\"$1\"'::regclass AND indisunique AND indpred IS NULL
        ORDER BY array_length(indkey,1) LIMIT 1) i
  JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ord) ON true
  JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
)
SELECT coalesce(nullif((SELECT cols FROM pk), ''), (SELECT cols FROM uq), '')"; }
# "col=EXCLUDED.col, ..." for every non-PK, non-generated column.
setlist_of() { dst_q "SELECT string_agg(format('%I = EXCLUDED.%I', attname, attname), ', ' ORDER BY attnum) FROM pg_attribute a WHERE a.attrelid='public.\"$1\"'::regclass AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' AND a.attname <> ALL (SELECT a2.attname FROM pg_constraint c JOIN unnest(c.conkey) ck(attnum) ON true JOIN pg_attribute a2 ON a2.attrelid=c.conrelid AND a2.attnum=ck.attnum WHERE c.conrelid=a.attrelid AND c.contype='p')"; }
has_updated() { dst_q "SELECT 1 FROM pg_attribute WHERE attrelid='public.\"$1\"'::regclass AND attname='updated_at' AND NOT attisdropped AND attgenerated=''"; }
has_generated() { dst_q "SELECT count(*) FROM pg_attribute WHERE attrelid='public.\"$1\"'::regclass AND attgenerated <> '' AND NOT attisdropped"; }
src_count() { src_q "SELECT count(*) FROM public.\"$1\""; }
dst_count() { dst_q "SELECT count(*) FROM public.\"$1\""; }

# --- DRY RUN: show the plan, write nothing ---------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  echo
  printf "  %-34s %10s %10s   %s\n" "table" "src_rows" "dst_rows" "strategy"
  printf "  %-34s %10s %10s   %s\n" "-----" "--------" "--------" "--------"
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    pk="$(pk_of "$t")"
    sc="$(src_count "$t")"; dc="$(dst_count "$t")"
    if [ -z "$pk" ]; then strat="SKIP (no primary key)";
    elif [ -n "$(has_updated "$t")" ]; then strat="upsert (newest-wins on updated_at)";
    else strat="insert-missing (no updated_at)"; fi
    printf "  %-34s %10s %10s   %s\n" "$t" "${sc:-0}" "${dc:-0}" "$strat"
  done <<< "$TABLES"
  echo
  echo "[db-merge] Dry run only — nothing was written."
  exit 0
fi

# --- Guard: refuse if any generated columns exist (COPY can't populate them) -
while IFS= read -r t; do
  [ -n "$t" ] || continue
  if [ "$(has_generated "$t")" != "0" ]; then
    fail "Table '$t' has GENERATED columns; this merge path doesn't support them. Use the full-clobber scripts."
  fi
done <<< "$TABLES"

# --- Confirm + backup destination (recoverable mistake) --------------------
if [ "$FORCE" -ne 1 ]; then
  echo
  echo "  This MERGES $SRC_LABEL into $DST_LABEL (insert-missing + update-if-newer)."
  echo "  Nothing on $DST_LABEL is deleted. A backup of $DST_LABEL is taken first."
  read -r -p "  Continue? [y/N] " ans
  case "$ans" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 0 ;; esac
fi

mkdir -p /tmp/openbriefing-db-backups
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/tmp/openbriefing-db-backups/${DST_LABEL}-before-merge-${DIRECTION}-${STAMP}.dump"
echo "[db-merge] Backing up destination ($DST_LABEL) -> $BACKUP ..."
if "$PG_DUMP" "$DST_URL" --format=custom --data-only --schema=public \
    --exclude-table='_prisma_migrations' --no-owner --no-privileges \
    --file="$BACKUP" 2>/tmp/openbriefing-db-backups/.dumperr-$$; then
  echo "[db-merge]   backup ok ($(du -h "$BACKUP" | cut -f1))."
else
  echo "[db-merge]   ⚠️  backup failed (see /tmp/openbriefing-db-backups/.dumperr-$$)."
  if [ "$FORCE" -ne 1 ]; then
    read -r -p "  Continue WITHOUT a recoverable backup? [y/N] " a2
    case "$a2" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 0 ;; esac
  fi
fi

# --- Capture + drop destination FKs ----------------------------------------
FK_DROP="/tmp/db-merge-fk-drop-$$.sql"
FK_ADD="/tmp/db-merge-fk-add-$$.sql"
trap 'rm -f "$FK_DROP" "$FK_ADD"; "$PSQL" "$DST_URL" -X -q -c "DROP SCHEMA IF EXISTS staging CASCADE" >/dev/null 2>&1 || true' EXIT

echo "[db-merge] Capturing + dropping FKs on $DST_LABEL ..."
"$PSQL" "$DST_URL" -X -tAc "
SELECT 'ALTER TABLE ' || conrelid::regclass || ' DROP CONSTRAINT ' || quote_ident(conname) || ';'
FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace
ORDER BY conrelid::regclass::text" > "$FK_DROP"
"$PSQL" "$DST_URL" -X -tAc "
SELECT 'ALTER TABLE ' || conrelid::regclass || ' ADD CONSTRAINT ' || quote_ident(conname) || ' ' || pg_get_constraintdef(oid) || ';'
FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace
ORDER BY conrelid::regclass::text" > "$FK_ADD"
"$PSQL" "$DST_URL" -X -v ON_ERROR_STOP=1 -f "$FK_DROP" >/dev/null

"$PSQL" "$DST_URL" -X -q -c "DROP SCHEMA IF EXISTS staging CASCADE; CREATE SCHEMA staging;" >/dev/null

# --- Per-table merge --------------------------------------------------------
TOTAL_INS=0
TOTAL_UPD=0
while IFS= read -r t; do
  [ -n "$t" ] || continue
  pk="$(pk_of "$t")"
  if [ -z "$pk" ]; then
    echo "[db-merge]   $t: SKIP (no primary key)"
    continue
  fi
  cols="$(cols_of "$t")"
  setlist="$(setlist_of "$t")"

  # Staging table mirrors the destination's columns/types exactly.
  # (client_min_messages=warning silences the benign "table ... does not exist,
  # skipping" NOTICE that DROP TABLE IF EXISTS emits on the first pass.)
  "$PSQL" "$DST_URL" -X -v ON_ERROR_STOP=1 -q \
    -c "SET client_min_messages = warning; DROP TABLE IF EXISTS staging.\"$t\"; CREATE TABLE staging.\"$t\" (LIKE public.\"$t\");" >/dev/null

  # Binary COPY source -> staging (all types round-trip, incl. halfvec/jsonb).
  if ! "$PSQL" "$SRC_URL" -X -v ON_ERROR_STOP=1 -q \
        -c "\copy public.\"$t\" ($cols) TO STDOUT (FORMAT binary)" \
      | "$PSQL" "$DST_URL" -X -v ON_ERROR_STOP=1 -q \
        -c "\copy staging.\"$t\" ($cols) FROM STDIN (FORMAT binary)"; then
    fail "COPY failed for table '$t'."
  fi

  # Build the conflict action: newest-wins when updated_at exists, else
  # insert-missing only. (setlist is empty only when every column is PK.)
  if [ -n "$(has_updated "$t")" ] && [ -n "$setlist" ]; then
    conflict="DO UPDATE SET $setlist WHERE tgt.updated_at < EXCLUDED.updated_at"
  else
    conflict="DO NOTHING"
  fi

  counts="$("$PSQL" "$DST_URL" -X -tA -v ON_ERROR_STOP=1 -c "
WITH merged AS (
  INSERT INTO public.\"$t\" AS tgt ($cols)
  SELECT $cols FROM staging.\"$t\"
  ON CONFLICT ($pk) $conflict
  RETURNING (xmax = 0) AS inserted
)
SELECT count(*) FILTER (WHERE inserted) || '|' || count(*) FILTER (WHERE NOT inserted) FROM merged;")"
  ins="${counts%%|*}"; upd="${counts##*|}"
  ins="${ins:-0}"; upd="${upd:-0}"
  TOTAL_INS=$((TOTAL_INS + ins))
  TOTAL_UPD=$((TOTAL_UPD + upd))
  echo "[db-merge]   $t: +$ins inserted, ~$upd updated"

  "$PSQL" "$DST_URL" -X -q -c "DROP TABLE IF EXISTS staging.\"$t\";" >/dev/null
done <<< "$TABLES"

# --- Re-add FKs -------------------------------------------------------------
echo "[db-merge] Re-adding FKs on $DST_LABEL ..."
"$PSQL" "$DST_URL" -X -v ON_ERROR_STOP=1 -f "$FK_ADD" >/dev/null

# --- Bump autoincrement sequences so future inserts don't collide ----------
echo "[db-merge] Resetting autoincrement sequences on $DST_LABEL ..."
SEQ_SQL="$("$PSQL" "$DST_URL" -X -tAc "
SELECT format('SELECT setval(pg_get_serial_sequence(%L, %L), GREATEST(coalesce((SELECT max(%I) FROM public.%I), 0), 1));',
              'public.'||table_name, column_name, column_name, table_name)
FROM information_schema.columns
WHERE table_schema='public' AND column_default LIKE 'nextval(%'")"
if [ -n "$SEQ_SQL" ]; then
  echo "$SEQ_SQL" | "$PSQL" "$DST_URL" -X -q -v ON_ERROR_STOP=1 >/dev/null
fi

echo
echo "[db-merge] ✅ Merge complete. $SRC_LABEL -> $DST_LABEL"
echo "[db-merge]    Totals: +$TOTAL_INS inserted, ~$TOTAL_UPD updated (nothing deleted)."
echo "[db-merge]    Pre-merge $DST_LABEL backup: $BACKUP"
