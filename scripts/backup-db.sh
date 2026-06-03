#!/usr/bin/env bash
#
# Local backup of the (cloud) Postgres database.
#
# Dumps DATABASE_URL to a timestamped, compressed custom-format file under
# ./backups so you always have a local copy of the shared "brain". Restore with:
#
#   pg_restore --clean --if-exists --no-owner \
#     -d "postgresql://localhost:5432/openbriefing_local" \
#     backups/openbriefing-<stamp>.dump
#
# Requires the Postgres client tools (pg_dump). Install a version >= your
# server's major version (Neon runs a recent PG): `brew install postgresql@17`.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Resolve DATABASE_URL: prefer the environment, fall back to .env.
DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ] && [ -f .env ]; then
  DB_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
fi

if [ -z "$DB_URL" ]; then
  echo "[backup] ERROR: DATABASE_URL is not set (checked env and .env)." >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "[backup] ERROR: pg_dump not found. Install Postgres client tools:" >&2
  echo "          brew install postgresql@17" >&2
  exit 1
fi

mkdir -p backups
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="backups/openbriefing-${STAMP}.dump"

echo "[backup] Dumping database → ${OUT}"
# Custom format (-Fc): compressed and restorable with pg_restore.
# --no-owner / --no-privileges so it restores cleanly into a different role
# (e.g. your local Postgres user).
pg_dump "$DB_URL" --format=custom --no-owner --no-privileges --file "$OUT"

echo "[backup] Done: ${OUT} ($(du -h "$OUT" | cut -f1))"

# Retention: keep the 14 most-recent dumps, delete older ones.
KEEP=14
ls -1t backups/openbriefing-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
done
echo "[backup] Retained $(ls -1 backups/openbriefing-*.dump 2>/dev/null | wc -l | tr -d ' ') backup(s) in ./backups"
