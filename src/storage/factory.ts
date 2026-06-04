/**
 * Storage configuration helpers.
 *
 * A PostgreSQL database is REQUIRED. There is no local-JSON fallback: if no
 * database is configured the callers throw an actionable error instead of
 * silently writing files.
 */

/**
 * Check if a PostgreSQL database is configured.
 */
export function hasDatabaseConfig(): boolean {
  return !!(
    process.env.DATABASE_URL ||
    (process.env.DB_HOST && process.env.DB_NAME)
  );
}
