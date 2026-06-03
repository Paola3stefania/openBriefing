/**
 * Storage factory - creates the storage backend.
 *
 * A PostgreSQL database is REQUIRED. There is no local-JSON fallback: if no
 * database is configured the factory throws an actionable error instead of
 * silently writing files. The JSON backend survives only as a test fixture
 * (NODE_ENV=test + STORAGE_BACKEND=json).
 */

import type { IStorage } from "./interface.js";
import type { StorageBackend } from "../config/storage.js";
import { getConfig } from "../config/index.js";
import { JsonStorage } from "./json/index.js";
import { DatabaseStorage } from "./db/index.js";

/**
 * Check if a PostgreSQL database is configured.
 */
export function hasDatabaseConfig(): boolean {
  return !!(
    process.env.DATABASE_URL ||
    (process.env.DB_HOST && process.env.DB_NAME)
  );
}

const MISSING_DB_MESSAGE = [
  "OpenBriefing requires a PostgreSQL database — there is no local-JSON mode.",
  "Set DATABASE_URL to a Postgres connection string:",
  "  • Local dev:  postgresql://<user>@localhost:5432/openbriefing",
  "  • Cloud:      a Neon / Supabase / Vercel Postgres URL (shared across machines)",
  "Then run `npm run build` to apply migrations. See env.example / AGENTS.md.",
].join("\n");

/**
 * Create storage instance based on configuration.
 *
 * - "database" (default): PostgreSQL. Throws if no DATABASE_URL/DB_* is set.
 * - "json": test-only fixture; rejected unless NODE_ENV=test.
 */
export function createStorage(backend?: StorageBackend): IStorage {
  const config = getConfig();
  const storageBackend = backend || config.storage.backend;

  if (storageBackend === "json") {
    if (process.env.NODE_ENV !== "test") {
      throw new Error(MISSING_DB_MESSAGE);
    }
    console.error("[Storage] Using JSON file backend (NODE_ENV=test fixture)");
    return new JsonStorage();
  }

  if (!hasDatabaseConfig()) {
    throw new Error(MISSING_DB_MESSAGE);
  }

  console.error("[Storage] Using PostgreSQL backend");
  return new DatabaseStorage();
}

/**
 * Get storage instance from config (convenience function)
 */
export function getStorage(): IStorage {
  return createStorage();
}

