# Database Setup

PostgreSQL is **required**. OpenBriefing stores all data and agent memory in a database — there is no local-JSON mode. If `DATABASE_URL` (or `DB_*`) is not set, the server throws on startup.

Use a **local Postgres** for development, or a **cloud Postgres** (Neon / Supabase / Vercel) when you want the brain shared across machines and agents.

## Quick Setup

### 1. Install PostgreSQL

**macOS:**
```bash
brew install postgresql@14
brew services start postgresql@14
```

**Linux:**
```bash
sudo apt-get install postgresql
sudo systemctl start postgresql
```

**Docker:**
```bash
docker run --name openbriefing-postgres -e POSTGRES_PASSWORD=password -e POSTGRES_DB=openbriefing -p 5432:5432 -d postgres:14
```

### 2. Create Database

**macOS:**
```bash
createdb openbriefing
```

**Linux:**
```bash
psql -U postgres -c "CREATE DATABASE openbriefing;"
```

### 3. Set Environment Variable

Add to `.env`:
```env
DATABASE_URL=postgresql://user@localhost:5432/openbriefing
```

**Note:** On macOS, no password needed. On Linux, use: `postgresql://postgres:password@localhost:5432/openbriefing`

### 4. Run Migrations

```bash
# Generate Prisma Client and apply migrations
npx prisma migrate deploy

# Or for development (creates migration files)
npx prisma migrate dev
```

## JSON backend (tests only)

The legacy JSON file backend is no longer a supported runtime mode. It survives only as a unit-test fixture and is rejected unless `NODE_ENV=test`:

```env
NODE_ENV=test
STORAGE_BACKEND=json
```

Outside of tests the server always requires a PostgreSQL `DATABASE_URL`.

**Important:** When `DATABASE_URL` is set and `STORAGE_BACKEND` is not explicitly set to `json`, database saves are **required**. Operations will fail if the database is unavailable (no silent fallback to JSON). To use JSON storage, either unset `DATABASE_URL` or set `STORAGE_BACKEND=json`.
