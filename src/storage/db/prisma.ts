/**
 * Prisma client singleton for OpenBriefing.
 *
 * Routes to one of two databases based on the `OFFLINE_DB` env flag:
 *   - OFFLINE_DB=false (default) → DATABASE_URL (Neon / cloud)
 *   - OFFLINE_DB=true            → MEMORY_MIRROR_DATABASE_URL (local Postgres)
 *
 * MEMORY_MIRROR_DATABASE_URL doubles as the local URL because that's already
 * where memory writes are dual-mirrored — it's the same physical DB whether
 * we're using it as a mirror (OFFLINE_DB=false) or as the primary
 * (OFFLINE_DB=true). When primary == mirror URL, mirror.ts skips its
 * dual-write to avoid writing the same row twice.
 *
 * The choice is resolved once at module load, so flipping the flag requires
 * a process restart (e.g. restart the MCP server / `npm run dev` / Cursor).
 * Prisma CLI calls (migrate, generate, etc.) honor the same flag via the
 * `scripts/db-cli.sh` wrapper — see package.json `db:*` scripts.
 */

import { PrismaClient } from "@prisma/client";

/**
 * Decide which database the app is currently pointed at. Logged once on
 * startup so it's visible in MCP server logs whether you're talking to
 * Neon or local. Returns the resolved URL plus a short label for logs.
 */
export function getActiveDatabase(): { url: string; label: "neon" | "local" } {
  const offline = process.env.OFFLINE_DB === "true";
  const localUrl = process.env.MEMORY_MIRROR_DATABASE_URL?.trim();
  const cloudUrl = process.env.DATABASE_URL?.trim();

  if (offline && localUrl) {
    return { url: localUrl, label: "local" };
  }
  // Fall back to DATABASE_URL even if offline=true but the mirror URL isn't
  // set; Prisma will still error clearly if neither is defined.
  return { url: cloudUrl ?? "", label: "neon" };
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const active = getActiveDatabase();

if (!globalForPrisma.prisma && process.env.NODE_ENV !== "test") {
  // One-time startup log: which DB the agent will read/write through this run.
  // stderr keeps it out of the MCP JSON-RPC stdout channel.
  console.error(
    `[prisma] active database: ${active.label}` +
      (active.label === "local" ? " (OFFLINE_DB=true)" : ""),
  );
}

// Prisma's string-shorthand log config (e.g. `log: ["error"]`) — and its
// default config — print to STDOUT, which corrupts the MCP JSON-RPC channel
// and kills the client connection. Every PrismaClient in this process MUST
// be created through this factory: it emits log events and forwards them to
// stderr instead.
export function createSafePrismaClient(options?: { datasourceUrl?: string }): PrismaClient {
  const logLevels =
    process.env.NODE_ENV === "development"
      ? (["error", "warn"] as const)
      : (["error"] as const);

  const client = new PrismaClient({
    datasourceUrl: options?.datasourceUrl,
    log: logLevels.map((level) => ({ emit: "event" as const, level })),
  });

  for (const level of logLevels) {
    client.$on(level, (e: { message: string }) => {
      console.error(`[prisma:${level}]`, e.message);
    });
  }
  return client;
}

const prismaClient =
  globalForPrisma.prisma ??
  createSafePrismaClient({ datasourceUrl: active.url || undefined });

export const prisma = prismaClient;

// Always cache the prisma instance to prevent connection leaks
// This is safe in all environments - the singleton pattern ensures
// we reuse the same connection pool across the application
globalForPrisma.prisma = prismaClient;

// Ensure cleanup on process exit
process.on("beforeExit", async () => {
  await prisma.$disconnect();
});

/**
 * Close database connection
 */
export async function closePrisma(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * Check if database is connected
 */
export async function checkPrismaConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
