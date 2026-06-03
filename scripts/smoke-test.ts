/**
 * End-to-end smoke test for the offline-toggle + Ollama embedding rewrite.
 *
 *   1. OFFLINE_DB toggle routes Prisma at the right DB at runtime.
 *   2. Mirror auto-disables when active DB == mirror DB.
 *   3. Ollama embed call returns 1024-dim vector that matches EMBEDDING_DIM.
 *   4. ANN search through halfvec(1024) HNSW index returns sensible neighbors.
 *
 * Run via:
 *   npx tsx scripts/smoke-test.ts
 */
import "dotenv/config";

async function main() {
  let ok = 0;
  let fail = 0;

  function check(name: string, cond: boolean, detail?: string) {
    if (cond) {
      console.log(`  ✓ ${name}${detail ? `  (${detail})` : ""}`);
      ok++;
    } else {
      console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ""}`);
      fail++;
    }
  }

  console.log("\n=== 1. OFFLINE_DB toggle routes the Prisma client ===");
  // Spawn child processes so each gets a fresh Prisma module load — the
  // module is a singleton, so we can't flip OFFLINE_DB mid-process.
  const { spawnSync } = await import("child_process");
  const probeScript = `
    (async () => {
      const { prisma } = await import("./src/storage/db/prisma.js");
      const r = await prisma.$queryRawUnsafe("SELECT current_database() AS db");
      console.log("DB=" + r[0].db);
      await prisma.$disconnect();
    })().catch(e => { console.error(e); process.exit(1); });
  `;
  const probe = (offline: "true" | "false") =>
    spawnSync("npx", ["tsx", "-e", probeScript], {
      env: { ...process.env, OFFLINE_DB: offline },
      encoding: "utf8",
    });

  const r1 = probe("false");
  const dbFalse = (r1.stdout.match(/DB=(\w+)/) || [])[1];
  check(
    "OFFLINE_DB=false → connects to neondb",
    dbFalse === "neondb",
    `current_database()=${dbFalse ?? "(none)"}`,
  );

  const r2 = probe("true");
  const dbTrue = (r2.stdout.match(/DB=(\w+)/) || [])[1];
  check(
    "OFFLINE_DB=true → connects to briefings",
    dbTrue === "briefings",
    `current_database()=${dbTrue ?? "(none)"}`,
  );

  console.log("\n=== 2. Mirror auto-disables when active == mirror ===");
  // Reset offline flag, re-import mirror module fresh.
  process.env.OFFLINE_DB = "false";
  const mirrorOnlineMod = await import(`../src/storage/db/mirror.js?t=${Date.now()}-1`);
  const mirrorOnline = mirrorOnlineMod.getMirrorPrisma();
  check(
    "OFFLINE_DB=false → mirror enabled",
    mirrorOnline !== null,
  );
  if (mirrorOnline) await mirrorOnline.$disconnect();

  process.env.OFFLINE_DB = "true";
  // Re-import prisma first so getActiveDatabase resolves to local, then mirror.
  await import(`../src/storage/db/prisma.js?t=${Date.now()}-2`);
  const mirrorOfflineMod = await import(`../src/storage/db/mirror.js?t=${Date.now()}-2`);
  const mirrorOffline = mirrorOfflineMod.getMirrorPrisma();
  check(
    "OFFLINE_DB=true → mirror disabled (active IS mirror)",
    mirrorOffline === null,
  );

  console.log("\n=== 3. Ollama embed dim matches EMBEDDING_DIM ===");
  process.env.OFFLINE_DB = "false";
  const { embedText } = await import("../src/embeddings/embed.js");
  const { EMBEDDING_DIM } = await import("../src/storage/db/vector.js");
  let vec: number[] | null = null;
  try {
    vec = await embedText("smoke test for openbriefing semantic search");
  } catch (e) {
    check("Ollama reachable", false, (e as Error).message);
  }
  if (vec) {
    check(
      "Ollama embedding dim matches EMBEDDING_DIM",
      vec.length === EMBEDDING_DIM,
      `got ${vec.length}, expected ${EMBEDDING_DIM}`,
    );
    check(
      "embedding values are real floats",
      vec.every((v) => typeof v === "number" && !Number.isNaN(v)),
    );
  }

  console.log("\n=== 4. ANN search through halfvec(1024) HNSW index ===");
  if (vec) {
    const finalMod = await import(`../src/storage/db/prisma.js?t=${Date.now()}-3`);
    const { toSqlVector } = await import("../src/storage/db/vector.js");
    const literal = toSqlVector(vec);
    type Row = { id: string; summary: string; distance: number };
    const rows = await finalMod.prisma.$queryRawUnsafe<Row[]>(
      `SELECT m.id, m.summary, (e.embedding <=> $1::halfvec) AS distance
       FROM memory_entry_embeddings e
       JOIN memory_entries m ON m.id = e.memory_id
       ORDER BY e.embedding <=> $1::halfvec
       LIMIT 5`,
      literal,
    );
    check(
      "ANN query returns rows",
      rows.length > 0,
      `${rows.length} neighbors`,
    );
    if (rows.length > 0) {
      check(
        "distances are valid (0..2)",
        rows.every((r) => Number(r.distance) >= 0 && Number(r.distance) <= 2),
      );
      console.log("\n  Top 3 nearest memories to 'smoke test for openbriefing semantic search':");
      for (const r of rows.slice(0, 3)) {
        const d = Number(r.distance).toFixed(4);
        const summary = r.summary.length > 80 ? r.summary.slice(0, 77) + "…" : r.summary;
        console.log(`    [${d}]  ${summary}`);
      }
    }
    await finalMod.prisma.$disconnect();
  }

  console.log(`\n=== Result: ${ok} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke test fatal:", e);
  process.exit(1);
});
