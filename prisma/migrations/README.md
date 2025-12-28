# Prisma Migrations

This directory contains Prisma migrations for the UNMute MCP database.

## Initial Setup

The `0_init` migration contains the baseline schema. Since the database already exists with this schema, it has been marked as applied.

## Using Migrations

### Mark Initial Migration as Applied

Since your database already has the schema, mark the initial migration as applied:

```bash
DATABASE_URL=postgresql://user@localhost:5432/unmute_mcp npx prisma migrate resolve --applied 0_init
```

### Create New Migrations

For future schema changes:

```bash
# 1. Update prisma/schema.prisma
# 2. Create migration
DATABASE_URL=postgresql://user@localhost:5432/unmute_mcp npx prisma migrate dev --name your_migration_name

# 3. Apply in production
DATABASE_URL=postgresql://user@localhost:5432/unmute_mcp npx prisma migrate deploy
```

### Check Migration Status

```bash
DATABASE_URL=postgresql://user@localhost:5432/unmute_mcp npx prisma migrate status
```

## Migration History

- `0_init` - Baseline migration with all tables (channels, classified_threads, groups, embeddings, etc.)

