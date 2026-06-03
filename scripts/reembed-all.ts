/**
 * Re-embed every persisted source row using the active embedding provider.
 *
 * Run this after a model dimension change (e.g. the halfvec(3072 → 1024)
 * migration) or when switching providers (Ollama ↔ OpenAI). Each batch
 * round-trips to the provider once; with Ollama running locally on
 * `mxbai-embed-large` and a modest GPU you'll see ~50-200 embeddings/sec.
 *
 * Usage:
 *   npm run reembed:all                                      # everything
 *   npm run reembed:all -- --table=code_files --limit=200    # one source
 *   npm run reembed:all -- --dry-run                         # count only
 *   npm run reembed:all -- --batch-size=64
 *
 * Idempotency: writes go through `upsertEmbedding`, which UPSERTs by primary
 * key. Running the script twice is safe (rows just get overwritten with the
 * same vectors). To force a partial rerun, pass `--table=<name>`.
 */
import "dotenv/config";
import { createHash } from "crypto";
import { prisma } from "../src/storage/db/prisma.js";
import { embedTexts, getActiveEmbeddingModel } from "../src/embeddings/embed.js";
import { upsertEmbedding, type EmbeddingTable } from "../src/storage/db/vectorIO.js";
import { toSqlVector } from "../src/storage/db/vector.js";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

interface CliArgs {
  table?: string;
  limit?: number;
  batchSize: number;
  dryRun: boolean;
  resume: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { batchSize: 32, dryRun: false, resume: false };
  for (const x of argv.slice(2)) {
    if (x === "--dry-run") args.dryRun = true;
    else if (x === "--resume") args.resume = true;
    else if (x.startsWith("--table=")) args.table = x.slice(8);
    else if (x.startsWith("--limit=")) args.limit = Number(x.slice(8));
    else if (x.startsWith("--batch-size=")) args.batchSize = Number(x.slice(13));
  }
  return args;
}

/**
 * With --resume, skip rows whose target embedding already exists with the
 * current model. Cheap PK-existence check — does NOT compare content_hash,
 * so if a source row's text changed since the last partial run you should
 * either re-run without --resume, or `--table=<name>` for the affected source.
 */
async function filterAlreadyEmbedded(
  spec: SourceSpec,
  rows: SourceRow[],
  model: string,
): Promise<SourceRow[]> {
  if (rows.length === 0) return rows;
  if (spec.target === "pr_learnings_inline") {
    const ids = rows.map((r) => String(r.pk));
    const done = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "pr_learnings" WHERE id = ANY($1::text[]) AND embedding IS NOT NULL`,
      ids,
    );
    const doneSet = new Set(done.map((r) => r.id));
    return rows.filter((r) => !doneSet.has(String(r.pk)));
  }
  const tableMeta = (await import("../src/storage/db/vectorIO.js")).EMBEDDING_TABLES[spec.target];
  const pkCol = tableMeta.pk;
  const pkVals = rows.map((r) => r.pk);
  const sample = pkVals[0];
  const arrType = typeof sample === "number" ? "int[]" : "text[]";
  const done = await prisma.$queryRawUnsafe<Array<Record<string, string | number>>>(
    `SELECT "${pkCol}"::text AS pk FROM "${spec.target}" WHERE "${pkCol}" = ANY($1::${arrType}) AND model = $2`,
    pkVals,
    model,
  );
  const doneSet = new Set(done.map((r) => String(r.pk)));
  return rows.filter((r) => !doneSet.has(String(r.pk)));
}

interface SourceRow {
  pk: string | number;
  text: string;
  extra?: Record<string, string | number>;
}

interface SourceSpec {
  name: string;
  /**
   * Either a target embedding-only table (vectorIO.upsertEmbedding) or
   * "inline" for sources that embed directly on the source row (pr_learnings).
   */
  target: EmbeddingTable | "pr_learnings_inline";
  loadRows: (limit?: number) => Promise<SourceRow[]>;
}

const SOURCES: SourceSpec[] = [
  {
    name: "github_issues",
    target: "issue_embeddings",
    loadRows: async (limit) => {
      const rows = await prisma.gitHubIssue.findMany({
        select: {
          id: true,
          issueNumber: true,
          issueRepo: true,
          issueTitle: true,
          issueBody: true,
          issueLabels: true,
        },
        orderBy: { issueUpdatedAt: "desc" },
        ...(limit ? { take: limit } : {}),
      });
      return rows.map((r) => ({
        pk: r.id,
        text:
          `${r.issueRepo}#${r.issueNumber} ${r.issueTitle}\n` +
          `${r.issueBody ?? ""}\n` +
          `labels: ${(r.issueLabels ?? []).join(", ")}`,
      }));
    },
  },
  {
    name: "code_files",
    target: "code_file_embeddings",
    loadRows: async (limit) => {
      const rows = await prisma.codeFile.findMany({
        select: { id: true, filePath: true, fileContent: true },
        orderBy: { lastIndexedAt: "desc" },
        ...(limit ? { take: limit } : {}),
      });
      return rows.map((r) => ({
        pk: r.id,
        text: `${r.filePath}\n${r.fileContent}`,
      }));
    },
  },
  {
    name: "code_sections",
    target: "code_section_embeddings",
    loadRows: async (limit) => {
      const rows = await prisma.codeSection.findMany({
        select: {
          id: true,
          sectionType: true,
          sectionName: true,
          sectionContent: true,
        },
        orderBy: { createdAt: "desc" },
        ...(limit ? { take: limit } : {}),
      });
      return rows.map((r) => ({
        pk: r.id,
        text: `${r.sectionType} ${r.sectionName}\n${r.sectionContent}`,
      }));
    },
  },
  {
    name: "features",
    target: "feature_embeddings",
    loadRows: async (limit) => {
      const rows = await prisma.feature.findMany({
        select: {
          id: true,
          name: true,
          description: true,
          category: true,
          relatedKeywords: true,
        },
        orderBy: { extractedAt: "desc" },
        ...(limit ? { take: limit } : {}),
      });
      return rows.map((r) => ({
        pk: r.id,
        text:
          `${r.name}` +
          (r.category ? ` [${r.category}]` : "") +
          `\n${r.description ?? ""}\n` +
          `keywords: ${(r.relatedKeywords ?? []).join(", ")}`,
      }));
    },
  },
  {
    name: "documentation",
    target: "documentation_embeddings",
    loadRows: async (limit) => {
      const rows = await prisma.documentationCache.findMany({
        select: { url: true, title: true, content: true },
        orderBy: { fetchedAt: "desc" },
        ...(limit ? { take: limit } : {}),
      });
      return rows.map((r) => ({
        pk: r.url,
        text: `${r.title ?? ""}\n${r.content}`,
      }));
    },
  },
  {
    name: "documentation_sections",
    target: "documentation_section_embeddings",
    loadRows: async (limit) => {
      const rows = await prisma.documentationSection.findMany({
        select: {
          id: true,
          documentationUrl: true,
          title: true,
          content: true,
        },
        orderBy: { createdAt: "desc" },
        ...(limit ? { take: limit } : {}),
      });
      return rows.map((r) => ({
        pk: r.id,
        text: `${r.title}\n${r.content}`,
        extra: { documentation_url: r.documentationUrl },
      }));
    },
  },
  {
    name: "groups",
    target: "group_embeddings",
    loadRows: async (limit) => {
      const rows = await prisma.group.findMany({
        select: {
          id: true,
          suggestedTitle: true,
          channelId: true,
          githubIssueNumber: true,
        },
        orderBy: { updatedAt: "desc" },
        ...(limit ? { take: limit } : {}),
      });
      return rows.map((r) => ({
        pk: r.id,
        text:
          `${r.suggestedTitle}` +
          (r.githubIssueNumber ? ` (issue #${r.githubIssueNumber})` : "") +
          ` channel:${r.channelId}`,
      }));
    },
  },
  {
    name: "memory_entries",
    target: "memory_entry_embeddings",
    loadRows: async (limit) => {
      const rows = await prisma.memoryEntry.findMany({
        select: { id: true, summary: true, content: true, tags: true },
        orderBy: { createdAt: "desc" },
        ...(limit ? { take: limit } : {}),
      });
      return rows.map((r) => ({
        pk: r.id,
        text:
          `${r.summary}\n${r.content}` +
          ((r.tags ?? []).length ? `\ntags: ${r.tags.join(", ")}` : ""),
      }));
    },
  },
  {
    name: "pr_learnings",
    target: "pr_learnings_inline",
    loadRows: async (limit) => {
      const rows = await prisma.pRLearning.findMany({
        select: {
          id: true,
          issueTitle: true,
          issueBody: true,
          prTitle: true,
          prBody: true,
          fixPatterns: true,
          subsystem: true,
        },
        orderBy: { learnedAt: "desc" },
        ...(limit ? { take: limit } : {}),
      });
      return rows.map((r) => ({
        pk: r.id,
        text:
          `${r.issueTitle}\n${r.issueBody ?? ""}\n` +
          `PR: ${r.prTitle}\n${r.prBody ?? ""}\n` +
          (r.subsystem ? `subsystem: ${r.subsystem}\n` : "") +
          (r.fixPatterns?.length ? `patterns: ${r.fixPatterns.join(", ")}` : ""),
      }));
    },
  },
];

/**
 * pr_learnings stores its embedding inline on the source row, not in a
 * separate join table — vectorIO.upsertEmbedding doesn't cover it. We do the
 * upsert directly here.
 */
async function upsertPrLearningEmbedding(opts: {
  id: string;
  embedding: number[];
  contentHash: string;
}): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "pr_learnings"
     SET "embedding" = $1::halfvec,
         "content_hash" = $2,
         "updated_at" = now()
     WHERE "id" = $3`,
    toSqlVector(opts.embedding),
    opts.contentHash,
    opts.id,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const model = getActiveEmbeddingModel();
  console.log(`[reembed] active model = ${model}`);
  console.log(`[reembed] batch size   = ${args.batchSize}`);
  if (args.dryRun) console.log("[reembed] DRY RUN — counting only");

  const sources = args.table ? SOURCES.filter((s) => s.name === args.table) : SOURCES;
  if (sources.length === 0) {
    console.error(
      `[reembed] no source matches --table=${args.table}. Valid: ${SOURCES.map((s) => s.name).join(", ")}`,
    );
    process.exit(1);
  }

  let totalEmbedded = 0;
  let totalFailed = 0;
  const startedAt = Date.now();

  for (const src of sources) {
    const allRows = await src.loadRows(args.limit);
    const rows = args.resume
      ? await filterAlreadyEmbedded(src, allRows, model)
      : allRows;
    if (args.resume && rows.length < allRows.length) {
      console.log(
        `[reembed] ${src.name}: ${rows.length} rows  (skipped ${allRows.length - rows.length} already embedded)`,
      );
    } else {
      console.log(`[reembed] ${src.name}: ${rows.length} rows`);
    }
    if (args.dryRun || rows.length === 0) continue;

    let embeddedThisSource = 0;
    for (let i = 0; i < rows.length; i += args.batchSize) {
      const batch = rows.slice(i, i + args.batchSize);
      try {
        const vectors = await embedTexts(batch.map((b) => b.text));
        if (src.target === "pr_learnings_inline") {
          await Promise.all(
            batch.map((row, j) =>
              upsertPrLearningEmbedding({
                id: String(row.pk),
                embedding: vectors[j],
                contentHash: md5(row.text),
              }),
            ),
          );
        } else {
          const target = src.target;
          await Promise.all(
            batch.map((row, j) =>
              upsertEmbedding({
                table: target,
                pkValue: row.pk,
                embedding: vectors[j],
                contentHash: md5(row.text),
                model,
                extraColumns: row.extra,
              }),
            ),
          );
        }
        totalEmbedded += batch.length;
        embeddedThisSource += batch.length;
      } catch (err) {
        totalFailed += batch.length;
        console.error(
          `[reembed] ${src.name} batch @${i}..${i + batch.length}: ${(err as Error).message}`,
        );
      }
      // Heartbeat every ~10 batches.
      if (((i / args.batchSize) | 0) % 10 === 9) {
        console.log(
          `  ${Math.min(i + args.batchSize, rows.length)}/${rows.length}  ok=${embeddedThisSource}  fail=${totalFailed}`,
        );
      }
    }
    console.log(
      `[reembed] ${src.name}: done. ${embeddedThisSource}/${rows.length} embedded`,
    );
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[reembed] ${seconds}s total. embedded=${totalEmbedded}  failed=${totalFailed}`,
  );
  process.exit(totalFailed > 0 && totalEmbedded === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[reembed] fatal:", err);
  process.exit(1);
});
