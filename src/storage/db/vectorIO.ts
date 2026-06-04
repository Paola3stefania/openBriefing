/**
 * Generic helpers for reading / writing the schema's halfvec embedding columns.
 *
 * Every embedding table in OpenBriefing has the same shape: a primary-key
 * column, an `embedding halfvec(1024)` column, plus `content_hash`, `model`,
 * `created_at`, `updated_at`. Prisma maps halfvec as `Unsupported`, so
 * Prisma's normal CRUD path can't read or write the embedding column — we go
 * through `$executeRawUnsafe` here.
 *
 * Why a single module (vs raw SQL inlined per table): the operator class and
 * literal cast (`::halfvec`) are the easiest things in this codebase to get
 * subtly wrong. Centralising them means a future model dim change or pgvector
 * version bump touches one file, not nine.
 *
 * Why `$executeRawUnsafe` is safe here: table and column names are never
 * passed in from user input. The two exported functions accept a
 * discriminated-union table descriptor, and every descriptor literal lives in
 * this file. Identifiers are double-quoted in the emitted SQL. Parameter
 * bindings ($1, $2, ...) carry every value, including the vector literal,
 * which is cast to `halfvec` in-query — Postgres handles the text→halfvec
 * coercion, no client-side type support needed.
 */

import type { PrismaClient } from "@prisma/client";
import { prisma } from "./prisma.js";
import { toSqlVector } from "./vector.js";

/**
 * Catalog of every embedding table the helper supports. Adding a new table
 * means adding an entry here AND a corresponding ALTER COLUMN in a migration
 * — there is no "add table" code path that bypasses this list.
 */
export const EMBEDDING_TABLES = {
  memory_entry_embeddings: { pk: "memory_id" },
  feature_embeddings: { pk: "feature_id" },
  code_file_embeddings: { pk: "code_file_id" },
  code_section_embeddings: { pk: "code_section_id" },
} as const;

export type EmbeddingTable = keyof typeof EMBEDDING_TABLES;

/**
 * Upsert a halfvec embedding row. `pkValue` is bound as a parameter, so the
 * caller doesn't need to worry about type — Postgres binds match the column's
 * declared type (text or int) automatically.
 *
 * `extraColumns` lets a table persist additional columns alongside the
 * embedding without forcing the simple tables to know about it. Keys must be
 * valid column names — they're double-quoted but never sanitised, so don't
 * take them from user input.
 */
export async function upsertEmbedding(options: {
  table: EmbeddingTable;
  pkValue: string | number;
  embedding: number[];
  contentHash: string;
  model: string;
  extraColumns?: Record<string, string | number>;
  client?: PrismaClient;
}): Promise<void> {
  const { table, pkValue, embedding, contentHash, model } = options;
  const client = options.client ?? prisma;
  const pkCol = EMBEDDING_TABLES[table].pk;
  const extra = options.extraColumns ?? {};
  const extraNames = Object.keys(extra);

  // Build a parameterised INSERT with the correct number of placeholders.
  // Order: pkValue, vector literal, contentHash, model, ...extra values.
  // Vector is cast to halfvec via the explicit ::halfvec on $2.
  const insertCols = [
    `"${pkCol}"`,
    `"embedding"`,
    `"content_hash"`,
    `"model"`,
    `"created_at"`,
    `"updated_at"`,
    ...extraNames.map((c) => `"${c}"`),
  ].join(", ");

  const insertVals = [
    "$1",
    "$2::halfvec",
    "$3",
    "$4",
    "now()",
    "now()",
    ...extraNames.map((_, i) => `$${5 + i}`),
  ].join(", ");

  const updateAssignments = [
    `"embedding" = EXCLUDED."embedding"`,
    `"content_hash" = EXCLUDED."content_hash"`,
    `"model" = EXCLUDED."model"`,
    `"updated_at" = now()`,
    ...extraNames.map((c) => `"${c}" = EXCLUDED."${c}"`),
  ].join(", ");

  const sql = `
    INSERT INTO "${table}" (${insertCols})
    VALUES (${insertVals})
    ON CONFLICT ("${pkCol}") DO UPDATE SET ${updateAssignments}
  `;

  await client.$executeRawUnsafe(
    sql,
    pkValue,
    toSqlVector(embedding),
    contentHash,
    model,
    ...extraNames.map((c) => extra[c]),
  );
}

/**
 * Fetch an embedding as a JS number[]. Returns null if no row, or if the
 * stored row's model doesn't match `model` (we treat model mismatch as
 * "missing" so callers transparently re-embed when the embedding model
 * changes — same semantics as the old Prisma-based getters).
 *
 * `currentContentHash`, when provided, additionally treats hash drift as
 * "missing". This is the cache-invalidation pattern most call sites use.
 *
 * The halfvec is materialised into JSON via pgvector's text representation
 * (`[v1,v2,...]`) and parsed back to a number[]. Faster paths exist for
 * "compute similarity in SQL" — those should use the `searchByVector` helper
 * below, not this one, so we only pay the round-trip cost when the JS code
 * actually needs the array.
 */
export async function getEmbedding(options: {
  table: EmbeddingTable;
  pkValue: string | number;
  model: string;
  currentContentHash?: string;
  client?: PrismaClient;
}): Promise<number[] | null> {
  const { table, pkValue, model } = options;
  const client = options.client ?? prisma;
  const pkCol = EMBEDDING_TABLES[table].pk;

  const sql = `
    SELECT
      "embedding"::text AS embedding_text,
      "content_hash"    AS content_hash,
      "model"           AS model
    FROM "${table}"
    WHERE "${pkCol}" = $1
    LIMIT 1
  `;

  const rows = await client.$queryRawUnsafe<
    Array<{ embedding_text: string | null; content_hash: string; model: string }>
  >(sql, pkValue);
  if (rows.length === 0) return null;
  const row = rows[0];

  if (row.model !== model) return null;
  if (options.currentContentHash && row.content_hash !== options.currentContentHash) {
    return null;
  }
  if (!row.embedding_text) return null;

  return parseVectorLiteral(row.embedding_text);
}

/**
 * Batch fetch — same semantics as `getEmbedding` but for many ids at once,
 * filtered by model. Returns a Map keyed by pkValue (stringified) so callers
 * with int keys (DocumentationSection) can still use it.
 */
export async function getEmbeddingsBatch(options: {
  table: EmbeddingTable;
  pkValues: Array<string | number>;
  model: string;
  client?: PrismaClient;
}): Promise<Map<string, number[]>> {
  const { table, pkValues, model } = options;
  if (pkValues.length === 0) return new Map();
  const client = options.client ?? prisma;
  const pkCol = EMBEDDING_TABLES[table].pk;

  // Build $1, $2, ... placeholders for the IN clause and bind each id
  // individually so Postgres handles type coercion per-value.
  const placeholders = pkValues.map((_, i) => `$${i + 1}`).join(", ");
  const modelParamIdx = pkValues.length + 1;
  const sql = `
    SELECT
      "${pkCol}"::text  AS pk,
      "embedding"::text AS embedding_text
    FROM "${table}"
    WHERE "${pkCol}" IN (${placeholders})
      AND "model" = $${modelParamIdx}
  `;

  const rows = await client.$queryRawUnsafe<
    Array<{ pk: string; embedding_text: string | null }>
  >(sql, ...pkValues, model);

  const out = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.embedding_text) continue;
    out.set(row.pk, parseVectorLiteral(row.embedding_text));
  }
  return out;
}

/**
 * Parse pgvector's text serialisation (`[1.23,4.56,...]`) back into a JS
 * number[]. Cheap because halfvec text output uses fixed comma separation
 * and decimal floats — no whitespace, no exponents in normal output. We
 * still tolerate optional whitespace and brackets at the edges.
 */
function parseVectorLiteral(text: string): number[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`Invalid vector literal: ${text.slice(0, 32)}…`);
  }
  const body = trimmed.slice(1, -1);
  if (body.length === 0) return [];
  return body.split(",").map((s) => Number(s));
}
