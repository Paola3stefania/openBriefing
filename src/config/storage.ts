/**
 * Storage configuration
 */

export type StorageBackend = "json" | "database";

export interface StorageConfig {
  backend: StorageBackend;
  defaultLimit?: {
    issues?: number;
    messages?: number;
  };
}

/**
 * Get storage configuration from environment variables.
 *
 * A PostgreSQL database is REQUIRED. OpenBriefing no longer ships a local-JSON
 * "try-it-out" mode — data and agent memory must live in a database (a local
 * Postgres for development, or a cloud Postgres such as Neon/Supabase/Vercel
 * for a shared brain).
 *
 * STORAGE_BACKEND:
 * - unset / "database": use PostgreSQL (the only supported mode).
 * - "json": legacy file backend, allowed ONLY when NODE_ENV=test so unit tests
 *   can run without a database. The factory refuses it outside tests.
 */
export function getStorageConfig(): StorageConfig {
  const raw = process.env.STORAGE_BACKEND;
  const isTest = process.env.NODE_ENV === "test";

  // The only sanctioned use of the JSON backend is the test suite.
  if (raw === "json") {
    if (!isTest) {
      console.warn(
        '[Config] STORAGE_BACKEND="json" is only supported under NODE_ENV=test; ' +
          "ignoring and using the database backend.",
      );
    } else {
      return { backend: "json" };
    }
  } else if (raw && raw !== "database") {
    console.warn(`[Config] Invalid STORAGE_BACKEND="${raw}", using "database"`);
  }

  const backend: StorageBackend = "database";
  
  // Parse default limits from environment (for try-it-out mode when DB is not configured)
  const defaultLimit: StorageConfig["defaultLimit"] = {};
  if (process.env.DEFAULT_FETCH_LIMIT_ISSUES) {
    const issuesLimit = parseInt(process.env.DEFAULT_FETCH_LIMIT_ISSUES, 10);
    if (!isNaN(issuesLimit) && issuesLimit > 0) {
      defaultLimit.issues = issuesLimit;
    }
  }
  if (process.env.DEFAULT_FETCH_LIMIT_MESSAGES) {
    const messagesLimit = parseInt(process.env.DEFAULT_FETCH_LIMIT_MESSAGES, 10);
    if (!isNaN(messagesLimit) && messagesLimit > 0) {
      defaultLimit.messages = messagesLimit;
    }
  }
  
  // Set defaults if not specified (100 for each)
  if (Object.keys(defaultLimit).length === 0) {
    defaultLimit.issues = 100;
    defaultLimit.messages = 100;
  } else {
    // Fill in missing defaults
    if (!defaultLimit.issues) defaultLimit.issues = 100;
    if (!defaultLimit.messages) defaultLimit.messages = 100;
  }
  
  return { backend, defaultLimit };
}

