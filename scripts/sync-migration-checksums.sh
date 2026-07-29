#!/usr/bin/env bash
#
# Re-point the checksums stored in `_prisma_migrations` at the current contents
# of each `migration.sql`.
#
# Why this is ever needed: if an already-applied migration is edited (for
# example to delete statements that were dead on every reachable code path),
# the stored checksum no longer matches the file. `prisma migrate deploy` and
# `prisma migrate status` do not care — verified against Prisma 6.19 — so
# production and CI are unaffected. But `prisma migrate dev` does check, and
# will want to reset the development database. Running this against each
# database that already has the edited migrations applied avoids that.
#
# The stored checksum is a plain SHA-256 of migration.sql, so recomputing it is
# exact rather than a guess.
#
# This only rewrites metadata in `_prisma_migrations`. It never touches your
# schema or data, and it never applies or reverts a migration.
#
# Usage:
#   bash scripts/sync-migration-checksums.sh            # dry run (default)
#   bash scripts/sync-migration-checksums.sh --apply
#   TARGET_DATABASE_URL=postgres://... bash scripts/sync-migration-checksums.sh --apply
#
# Target selection, in order of precedence:
#   1. TARGET_DATABASE_URL
#   2. the same OFFLINE_DB routing scripts/db-cli.sh uses:
#      OFFLINE_DB=true → MEMORY_MIRROR_DATABASE_URL, otherwise DATABASE_URL
#
# Remember to run it against *every* database that has the edited migrations
# recorded as applied — typically local and cloud both.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

read_env() {
  local key="$1"
  local val="${!key:-}"
  if [ -z "$val" ] && [ -f "$ROOT/.env" ]; then
    val="$(grep -E "^${key}=" "$ROOT/.env" | head -1 | cut -d= -f2-)"
  fi
  echo "$val"
}

URL="${TARGET_DATABASE_URL:-}"
if [ -z "$URL" ]; then
  if [ "$(read_env OFFLINE_DB)" = "true" ]; then
    URL="$(read_env MEMORY_MIRROR_DATABASE_URL)"
    echo "[checksums] OFFLINE_DB=true — targeting the local database" >&2
  else
    URL="$(read_env DATABASE_URL)"
    echo "[checksums] OFFLINE_DB is not true — targeting DATABASE_URL" >&2
  fi
fi

if [ -z "$URL" ]; then
  echo "[checksums] no target database URL resolved; set TARGET_DATABASE_URL" >&2
  exit 1
fi

# Show which database without leaking the password.
echo "[checksums] target: $(printf '%s' "$URL" | sed -E 's#(://[^:/@]+:)[^@]*@#\1***@#')"
[ "$APPLY" = "1" ] || echo "[checksums] DRY RUN — pass --apply to write"

drifted=0
updated=0

while IFS= read -r dir; do
  name="$(basename "$dir")"
  disk="$(shasum -a 256 "$dir/migration.sql" | cut -d' ' -f1)"
  stored="$(psql "$URL" -qtAX -c \
    "SELECT checksum FROM _prisma_migrations WHERE migration_name = '$name' LIMIT 1;")"

  if [ -z "$stored" ]; then
    # Not applied here (or applied under a different name) — nothing to sync.
    continue
  fi
  if [ "$stored" = "$disk" ]; then
    continue
  fi

  drifted=$((drifted + 1))
  echo "  $name"
  echo "    stored: $stored"
  echo "    disk:   $disk"

  if [ "$APPLY" = "1" ]; then
    psql "$URL" -qtAX -c \
      "UPDATE _prisma_migrations SET checksum = '$disk' WHERE migration_name = '$name';" >/dev/null
    updated=$((updated + 1))
  fi
done < <(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | sort)

if [ "$drifted" = "0" ]; then
  echo "[checksums] every applied migration already matches its file"
elif [ "$APPLY" = "1" ]; then
  echo "[checksums] updated $updated of $drifted drifted checksum(s)"
else
  echo "[checksums] $drifted drifted checksum(s) — re-run with --apply to write"
fi
