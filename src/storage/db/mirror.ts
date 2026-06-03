/**
 * Optional local mirror database for agent memory.
 *
 * When `MEMORY_MIRROR_DATABASE_URL` is set, every memory written to the primary
 * database (Neon/cloud) is ALSO written to this second database (typically a
 * local Postgres) so you always have a live local copy of the brain — not just
 * the periodic `npm run db:backup` snapshots.
 *
 * The mirror is strictly best-effort: a mirror failure NEVER fails the primary
 * write (see callers in memory.ts). The mirror database must have the same
 * schema as primary — including the pgvector extension — so apply migrations
 * against it first:
 *
 *   DATABASE_URL="postgresql://localhost:5432/openbriefing_local" npm run db:migrate
 *
 * then set in .env:
 *
 *   MEMORY_MIRROR_DATABASE_URL="postgresql://localhost:5432/openbriefing_local"
 */

import { PrismaClient } from "@prisma/client";
import { getActiveDatabase } from "./prisma.js";

// `undefined` = not yet resolved, `null` = resolved to "no mirror configured".
let mirrorClient: PrismaClient | null | undefined;

/**
 * Get the mirror Prisma client, or `null` when no mirror is configured.
 * Lazily instantiated and cached for the process lifetime.
 *
 * Returns null when OFFLINE_DB=true and the active primary IS the local
 * mirror DB — mirroring there would write the same row twice to the same
 * physical database.
 */
export function getMirrorPrisma(): PrismaClient | null {
  if (mirrorClient !== undefined) return mirrorClient;

  const url = process.env.MEMORY_MIRROR_DATABASE_URL?.trim();
  if (!url) {
    mirrorClient = null;
    return null;
  }

  // If the app's active DB IS the mirror URL (offline mode), skip mirroring.
  if (getActiveDatabase().url === url) {
    mirrorClient = null;
    return null;
  }

  mirrorClient = new PrismaClient({
    datasourceUrl: url,
    log: ["error"],
  });
  return mirrorClient;
}

/**
 * Disconnect the mirror client if one was created.
 */
export async function closeMirrorPrisma(): Promise<void> {
  if (mirrorClient) {
    await mirrorClient.$disconnect();
  }
}

process.on("beforeExit", async () => {
  await closeMirrorPrisma();
});
