/**
 * Backfill missing OpenAI embeddings for `MemoryEntry` rows.
 *
 * Why this exists: `saveMemory` (and by extension `end_agent_session({
 * related_insights })`) embeds memories best-effort. If the OpenAI API key
 * is missing/expired/rate-limited at write time, the row still lands but
 * without a `MemoryEntryEmbedding`, which means the briefing's
 * `relatedInsights[]` semantic ranking can't surface it later. This script
 * walks the orphan rows and computes their embeddings — typically run once
 * after fixing a broken `OPENAI_API_KEY`.
 *
 * Usage:
 *   npm run backfill:memory-embeddings
 *   npm run backfill:memory-embeddings -- --limit=20
 *   npm run backfill:memory-embeddings -- --project=Paola3stefania/openBriefing
 *   npm run backfill:memory-embeddings -- --dry-run
 *
 * Behavior:
 *   - Idempotent: rows that already have an embedding are skipped (we only
 *     query `MemoryEntry where embedding IS NULL`).
 *   - Defensive: exits 0 with a clear message if `OPENAI_API_KEY` is missing.
 *   - Sequential, rate-limit friendly: processes one row at a time with a
 *     small delay between calls. For large backlogs adjust `BATCH_DELAY_MS`.
 *   - Failure-tolerant: per-row errors are logged and counted; the script
 *     continues to the next row rather than aborting the whole backfill.
 */

import "dotenv/config";
import { prisma } from "../src/storage/db/prisma.js";
import { embedAndStoreMemoryEmbedding } from "../src/storage/db/memory.js";

const BATCH_DELAY_MS = 50;

interface CliArgs {
  limit?: number;
  project?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false };
  for (const arg of argv.slice(2)) {
    const [key, value] = arg.startsWith("--") ? arg.slice(2).split("=") : [arg, ""];
    if (key === "limit" && value) args.limit = Number(value);
    else if (key === "project" && value) args.project = value;
    else if (key === "dry-run") args.dryRun = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "[backfill] OPENAI_API_KEY is not set. Skipping — fix the key and rerun.",
    );
    process.exit(0);
  }

  const orphans = await prisma.memoryEntry.findMany({
    where: {
      embedding: null,
      ...(args.project ? { projectId: args.project } : {}),
    },
    select: { id: true, projectId: true, content: true, summary: true, sessionId: true },
    orderBy: { createdAt: "asc" },
    ...(args.limit ? { take: args.limit } : {}),
  });

  if (orphans.length === 0) {
    console.log("[backfill] No memories without embeddings — nothing to do.");
    process.exit(0);
  }

  console.log(
    `[backfill] Found ${orphans.length} memor${orphans.length === 1 ? "y" : "ies"} without embeddings${args.project ? ` (project=${args.project})` : ""}${args.dryRun ? " [DRY RUN]" : ""}.`,
  );

  if (args.dryRun) {
    for (const m of orphans) {
      console.log(
        `  - ${m.id}  project=${m.projectId}${m.sessionId ? ` session=${m.sessionId}` : ""}\n      ${m.summary.slice(0, 100)}`,
      );
    }
    process.exit(0);
  }

  let succeeded = 0;
  let failed = 0;
  const start = Date.now();

  for (let i = 0; i < orphans.length; i++) {
    const m = orphans[i];
    const ok = await embedAndStoreMemoryEmbedding({
      memoryId: m.id,
      content: m.content,
    });
    if (ok) {
      succeeded++;
      if ((i + 1) % 10 === 0 || i === orphans.length - 1) {
        console.log(
          `[backfill] ${i + 1}/${orphans.length} (${succeeded} ok, ${failed} failed)`,
        );
      }
    } else {
      failed++;
      console.error(`[backfill] Failed to embed memory ${m.id} — see error above`);
    }
    if (i < orphans.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `[backfill] Done in ${seconds}s. ${succeeded} embedded, ${failed} failed.`,
  );

  if (failed > 0 && succeeded === 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] Fatal:", err);
  process.exit(1);
});
