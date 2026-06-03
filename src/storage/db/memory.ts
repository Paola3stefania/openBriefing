/**
 * Persistent conversation memory with semantic search.
 *
 * Stores memory entries (conversation snippets, decisions, learnings) as text
 * plus an OpenAI embedding in `memory_entry_embeddings.embedding`, which is
 * pgvector `halfvec(1024)` with an HNSW cosine index. Search uses the
 * indexed `<=>` operator, ordering and top-k happen in Postgres.
 */

import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "./prisma.js";
import { getMirrorPrisma } from "./mirror.js";
import { createEmbedding } from "../../core/classify/semantic.js";
import { getLLMApiKey } from "../../llm/chat.js";
import { getConfig } from "../../config/index.js";
import { detectProjectId } from "../../config/project.js";
import { toSqlVector } from "./vector.js";
import { upsertEmbedding } from "./vectorIO.js";

function getEmbeddingModel(): string {
  return getConfig().classification.embeddingModel;
}

function getOpenAIApiKey(): string | null {
  // Returns a usable key for the active provider. Under Ollama (default) this
  // is a non-empty sentinel so embedding generation runs without an OpenAI key;
  // under OpenAI it's the real key (or "" → embed call throws a clear error).
  return getLLMApiKey();
}

function hashContent(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

/**
 * Generate the OpenAI embedding for a memory entry's content and persist it
 * to `memory_entry_embeddings`. Used both by `saveMemory` (write path) and
 * `backfill-memory-embeddings` (recovery path) so the embedding shape stays
 * identical no matter who originated the row.
 *
 * Returns `true` when the embedding row was created, `false` when it was
 * skipped (no API key, OpenAI unavailable, etc.). Idempotent against
 * pre-existing rows for the same `memoryId`.
 */
/**
 * Raw upsert of a single embedding row into the given client's
 * `memory_entry_embeddings`. Defers to the generic vectorIO helper so the
 * pgvector cast (`::halfvec`) and ON CONFLICT shape live in one place. The
 * memory row it references must already exist in that client's DB.
 */
async function upsertEmbeddingRow(
  client: PrismaClient,
  memoryId: string,
  embedding: number[],
  content: string,
): Promise<void> {
  await upsertEmbedding({
    client,
    table: "memory_entry_embeddings",
    pkValue: memoryId,
    embedding,
    contentHash: hashContent(content),
    model: getEmbeddingModel(),
  });
}

export async function embedAndStoreMemoryEmbedding(options: {
  memoryId: string;
  content: string;
  /** Pass an explicit API key to override the env-based default (tests). */
  apiKey?: string | null;
  /**
   * Databases to write the embedding into. Defaults to `[prisma]` (primary
   * only). `saveMemory` passes `[prisma, mirror]` when a local mirror is
   * configured so the embedding lands in both. Each write is independent and
   * best-effort; the return value reflects the PRIMARY write only.
   */
  clients?: PrismaClient[];
}): Promise<boolean> {
  const apiKey = options.apiKey ?? getOpenAIApiKey();
  if (!apiKey) return false;

  // Embed once, write to every target (avoids paying for the embedding twice
  // when mirroring).
  let embedding: number[];
  try {
    embedding = await createEmbedding(options.content, apiKey);
  } catch (err) {
    console.error(
      `[Memory] Failed to embed memory ${options.memoryId}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }

  const targets =
    options.clients && options.clients.length > 0 ? options.clients : [prisma];
  let primaryOk = false;
  for (const client of targets) {
    const isPrimary = client === prisma;
    try {
      await upsertEmbeddingRow(client, options.memoryId, embedding, options.content);
      if (isPrimary) primaryOk = true;
    } catch (err) {
      console.error(
        `[Memory] Failed to store embedding for ${options.memoryId} (${isPrimary ? "primary" : "mirror"}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return primaryOk;
}

/**
 * Best-effort replicate a memory row into the mirror DB so the mirror has the
 * row before its embedding (FK: memory_entry_embeddings.memory_id →
 * memory_entries.id). Keeps the same primary key so the mirror is a true copy.
 * A mirror failure is logged and swallowed — it must never fail the primary
 * write.
 */
async function mirrorMemoryRow(
  client: PrismaClient,
  entry: {
    id: string;
    projectId: string;
    content: string;
    summary: string;
    tags: string[];
    source: string;
    sessionId: string | null;
    createdAt: Date;
  },
): Promise<void> {
  try {
    // The mirror may not contain the originating session (we only mirror
    // memory, not sessions), so null the FK rather than violate it.
    let sessionId = entry.sessionId;
    if (sessionId) {
      const exists = await client.agentSession.findUnique({
        where: { id: sessionId },
        select: { id: true },
      });
      if (!exists) sessionId = null;
    }

    await client.memoryEntry.upsert({
      where: { id: entry.id },
      create: {
        id: entry.id,
        projectId: entry.projectId,
        content: entry.content,
        summary: entry.summary,
        tags: entry.tags,
        source: entry.source,
        sessionId,
        createdAt: entry.createdAt,
      },
      update: {
        projectId: entry.projectId,
        content: entry.content,
        summary: entry.summary,
        tags: entry.tags,
        source: entry.source,
        sessionId,
      },
    });
  } catch (err) {
    console.error(
      `[Memory] mirror row write failed for ${entry.id} (primary unaffected):`,
      err instanceof Error ? err.message : err,
    );
  }
}

export interface MemoryEntryResult {
  id: string;
  projectId: string;
  content: string;
  summary: string;
  tags: string[];
  source: string;
  /**
   * The session that authored this memory, when one exists. Populated by
   * `end_agent_session({ related_insights })` and any future automated
   * session-bound ingestion. `null` for manual `save_memory` calls and
   * imported context.
   */
  sessionId: string | null;
  createdAt: string;
  similarity?: number;
}

/**
 * Save a memory entry and generate its embedding.
 *
 * Pass `sessionId` to link the memory back to a session — that's the path
 * `end_agent_session({ related_insights })` uses so an agent's debrief lands
 * on the right work unit instead of in a free-floating memory bucket.
 * Briefings then surface session-linked memories with a navigable pointer
 * via `RelatedInsight.sessionId`.
 */
export async function saveMemory(options: {
  content: string;
  summary: string;
  tags?: string[];
  source?: string;
  projectId?: string;
  sessionId?: string;
}): Promise<MemoryEntryResult> {
  const projectId = options.projectId ?? detectProjectId();

  const entry = await prisma.memoryEntry.create({
    data: {
      projectId,
      content: options.content,
      summary: options.summary,
      tags: options.tags ?? [],
      source: options.source ?? "conversation",
      sessionId: options.sessionId ?? null,
    },
  });

  // Dual-write: if a local mirror DB is configured, replicate the row there
  // (before its embedding, for the FK). Best-effort — never fails the primary.
  const mirror = getMirrorPrisma();
  if (mirror) {
    await mirrorMemoryRow(mirror, entry);
  }

  // Best-effort: don't fail the save if OpenAI is unavailable. The row will
  // be picked up later by `npm run backfill:memory-embeddings`. When a mirror
  // is configured the embedding is written to both DBs from a single API call.
  await embedAndStoreMemoryEmbedding({
    memoryId: entry.id,
    content: options.content,
    clients: mirror ? [prisma, mirror] : undefined,
  });

  return mapEntry(entry);
}

/**
 * Search memories semantically. Falls back to keyword search if no embeddings exist
 * or OpenAI is unavailable.
 */
export async function searchMemory(options: {
  query: string;
  limit?: number;
  projectId?: string;
  tags?: string[];
}): Promise<MemoryEntryResult[]> {
  const projectId = options.projectId ?? detectProjectId();
  const limit = options.limit ?? 5;
  const apiKey = getOpenAIApiKey();

  const tagFilter = options.tags && options.tags.length > 0
    ? { tags: { hasSome: options.tags } }
    : {};

  // Try semantic search first, via an indexed pgvector ANN query. `<=>` is
  // cosine distance, so similarity = 1 - distance. Ordering happens in the DB
  // (HNSW index) and only the top `limit` rows are returned — no JS cosine
  // loop, and no 200-row recency cap.
  if (apiKey) {
    try {
      const queryEmbedding = await createEmbedding(options.query, apiKey);
      const queryVec = toSqlVector(queryEmbedding);
      const tagCond =
        options.tags && options.tags.length > 0
          ? Prisma.sql`AND m."tags" && ${options.tags}::text[]`
          : Prisma.empty;

      const rows = await prisma.$queryRaw<
        Array<{
          id: string;
          projectId: string;
          content: string;
          summary: string;
          tags: string[];
          source: string;
          sessionId: string | null;
          createdAt: Date;
          similarity: number;
        }>
      >(Prisma.sql`
        SELECT
          m."id",
          m."project_id"  AS "projectId",
          m."content",
          m."summary",
          m."tags",
          m."source",
          m."session_id"  AS "sessionId",
          m."created_at"  AS "createdAt",
          1 - (e."embedding" <=> ${queryVec}::halfvec) AS "similarity"
        FROM "memory_entries" m
        JOIN "memory_entry_embeddings" e ON e."memory_id" = m."id"
        WHERE m."project_id" = ${projectId}
        ${tagCond}
        ORDER BY e."embedding" <=> ${queryVec}::halfvec
        LIMIT ${limit}
      `);

      const relevant = rows.filter((r) => Number(r.similarity) > 0.3);
      if (relevant.length > 0) {
        return relevant.map((r) => ({
          id: r.id,
          projectId: r.projectId,
          content: r.content,
          summary: r.summary,
          tags: r.tags,
          source: r.source,
          sessionId: r.sessionId ?? null,
          createdAt: r.createdAt.toISOString(),
          similarity: Number(Number(r.similarity).toFixed(3)),
        }));
      }
    } catch (err) {
      console.error("[Memory] Semantic search failed, falling back to keyword:", err);
    }
  }

  // Fallback: keyword search
  const entries = await prisma.memoryEntry.findMany({
    where: {
      projectId,
      ...tagFilter,
      OR: [
        { content: { contains: options.query, mode: "insensitive" } },
        { summary: { contains: options.query, mode: "insensitive" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return entries.map(mapEntry);
}

/**
 * List recent memories without search.
 */
export async function getRecentMemories(options: {
  limit?: number;
  projectId?: string;
  tags?: string[];
}): Promise<MemoryEntryResult[]> {
  const projectId = options.projectId ?? detectProjectId();
  const tagFilter = options.tags && options.tags.length > 0
    ? { tags: { hasSome: options.tags } }
    : {};

  const entries = await prisma.memoryEntry.findMany({
    where: { projectId, ...tagFilter },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 10,
  });

  return entries.map(mapEntry);
}

/**
 * Delete a memory entry by id.
 */
export async function deleteMemory(id: string): Promise<boolean> {
  try {
    await prisma.memoryEntry.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

function mapEntry(entry: {
  id: string;
  projectId: string;
  content: string;
  summary: string;
  tags: string[];
  source: string;
  sessionId?: string | null;
  createdAt: Date;
}): MemoryEntryResult {
  return {
    id: entry.id,
    projectId: entry.projectId,
    content: entry.content,
    summary: entry.summary,
    tags: entry.tags,
    source: entry.source,
    sessionId: entry.sessionId ?? null,
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * Pure shape-prep for `saveSessionInsights`: filters whitespace-only entries,
 * builds the deterministic tag set, and produces the auto-summary. Exported
 * so the empty-input / tag-shape edge cases can be unit-tested without
 * standing up Prisma.
 */
export function prepareSessionInsights(
  sessionId: string,
  insights: unknown[],
  extraTags: string[] = [],
): Array<{ content: string; summary: string; tags: string[] }> {
  const filtered = insights
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s): s is string => s.length > 0);
  if (filtered.length === 0) return [];

  const tags = ["session", `session:${sessionId}`, ...extraTags];

  return filtered.map((content) => ({
    content,
    summary:
      content.length > 240 ? `${content.slice(0, 237).trimEnd()}…` : content,
    tags,
  }));
}

/**
 * Bulk-save a list of free-form insights as session-linked memories. Each
 * entry gets its own embedding (best-effort, errors logged not thrown).
 *
 * This is the primitive that lets `end_agent_session({ related_insights })`
 * fold debrief content into the canonical session record AND into the
 * embedding-ranked briefing surface in one call. The whole point: stop
 * fragmenting "what did this session conclude?" between sessions and memory.
 */
export async function saveSessionInsights(options: {
  sessionId: string;
  projectId: string;
  insights: string[];
  tags?: string[];
}): Promise<MemoryEntryResult[]> {
  const prepared = prepareSessionInsights(
    options.sessionId,
    options.insights,
    options.tags ?? [],
  );
  if (prepared.length === 0) return [];

  const results: MemoryEntryResult[] = [];
  for (const item of prepared) {
    try {
      const entry = await saveMemory({
        content: item.content,
        summary: item.summary,
        tags: item.tags,
        source: "session",
        projectId: options.projectId,
        sessionId: options.sessionId,
      });
      results.push(entry);
    } catch (err) {
      console.error(
        `[Memory] saveSessionInsights: failed to persist insight for session ${options.sessionId}`,
        err,
      );
    }
  }
  return results;
}
