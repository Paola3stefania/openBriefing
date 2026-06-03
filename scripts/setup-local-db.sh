#!/usr/bin/env bash
#
# One-shot provisioning for the LOCAL mirror database (the "both local + Neon"
# setup). Creates a local Postgres database, enables pgvector, and applies the
# OpenBriefing migrations to it so it can serve as MEMORY_MIRROR_DATABASE_URL.
#
# Your PRIMARY database stays whatever DATABASE_URL points at (e.g. Neon). This
# script only sets up the local copy.
#
# Prerequisites (install once on a fresh Mac):
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
#   brew install postgresql@17 pgvector
#   brew services start postgresql@17
#   # and Node (for the migration step):
#   brew install node    # or use nvm
#
# Usage:
#   bash scripts/setup-local-db.sh [dbname]
#   (default dbname: briefings)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DB_NAME="${1:-briefings}"
PG_USER="${PGUSER:-$(whoami)}"
LOCAL_URL="postgresql://${PG_USER}@localhost:5432/${DB_NAME}"

fail() { echo "[setup-local-db] ERROR: $1" >&2; exit 1; }

# --- 1. Prerequisite checks ------------------------------------------------
command -v psql      >/dev/null 2>&1 || fail "psql not found. Install Postgres:  brew install postgresql@17 pgvector  &&  brew services start postgresql@17"
command -v createdb  >/dev/null 2>&1 || fail "createdb not found (Postgres client tools missing)."

if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  fail "No Postgres server responding on localhost:5432. Start it:  brew services start postgresql@17"
fi

# --- 2. Create the database (idempotent) -----------------------------------
if psql -h localhost -U "$PG_USER" -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
  echo "[setup-local-db] Database '${DB_NAME}' already exists — leaving it in place."
else
  echo "[setup-local-db] Creating database '${DB_NAME}'..."
  createdb -h localhost -U "$PG_USER" "$DB_NAME"
fi

# --- 3. Enable pgvector -----------------------------------------------------
echo "[setup-local-db] Enabling pgvector extension..."
if ! psql -h localhost -U "$PG_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS vector;' >/dev/null 2>&1; then
  fail "Could not enable the 'vector' extension. Install it:  brew install pgvector  (then re-run this script)."
fi

# --- 4. Apply migrations ----------------------------------------------------
if ! command -v npx >/dev/null 2>&1; then
  fail "npx not found. Install Node (brew install node, or nvm) and run 'npm install', then re-run this script."
fi

echo "[setup-local-db] Applying migrations to ${DB_NAME}..."
DATABASE_URL="$LOCAL_URL" npx prisma migrate deploy

# --- 5. Done ---------------------------------------------------------------
cat <<EOF

[setup-local-db] ✅ Local mirror database ready.

Add this to your .env to turn on live dual-write of agent memory:

  MEMORY_MIRROR_DATABASE_URL=${LOCAL_URL}

Take a point-in-time snapshot any time with:  npm run db:backup
EOF
