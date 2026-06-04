/**
 * Embedding storage operations for features and code (files + sections).
 *
 * Every embedding column in the schema is `halfvec(1024)` (Unsupported in
 * Prisma). Reads and writes go through the generic helpers in `vectorIO.ts`,
 * not Prisma's typed CRUD. This file just routes the embedding bytes through
 * raw SQL while the rest of each model stays normal.
 */

import { getConfig } from "../../config/index.js";
import {
  upsertEmbedding,
  getEmbedding as getEmbeddingFromTable,
  getEmbeddingsBatch,
} from "./vectorIO.js";

export type Embedding = number[];

/**
 * Get the embedding model from config
 */
function getEmbeddingModel(): string {
  const config = getConfig();
  return config.classification.embeddingModel;
}

export async function saveFeatureEmbedding(
  featureId: string,
  embedding: Embedding,
  contentHash: string
): Promise<void> {
  await upsertEmbedding({
    table: "feature_embeddings",
    pkValue: featureId,
    embedding,
    contentHash,
    model: getEmbeddingModel(),
  });
}

export async function getFeatureEmbedding(featureId: string): Promise<Embedding | null> {
  return getEmbeddingFromTable({
    table: "feature_embeddings",
    pkValue: featureId,
    model: getEmbeddingModel(),
  });
}

export async function saveCodeSectionEmbedding(
  codeSectionId: string,
  embedding: Embedding,
  contentHash: string
): Promise<void> {
  await upsertEmbedding({
    table: "code_section_embeddings",
    pkValue: codeSectionId,
    embedding,
    contentHash,
    model: getEmbeddingModel(),
  });
}

export async function getCodeSectionEmbedding(
  codeSectionId: string,
  currentContentHash?: string
): Promise<Embedding | null> {
  return getEmbeddingFromTable({
    table: "code_section_embeddings",
    pkValue: codeSectionId,
    model: getEmbeddingModel(),
    currentContentHash,
  });
}

/**
 * Batch get code section embeddings (avoids N+1 queries).
 * Returns a Map of sectionId → embedding for entries whose `model` matches the
 * configured one. Caller should treat missing keys as "no embedding".
 */
export async function getCodeSectionEmbeddingsBatch(
  sectionIds: string[]
): Promise<Map<string, Embedding>> {
  return getEmbeddingsBatch({
    table: "code_section_embeddings",
    pkValues: sectionIds,
    model: getEmbeddingModel(),
  });
}

export async function saveCodeFileEmbedding(
  codeFileId: string,
  embedding: Embedding,
  contentHash: string
): Promise<void> {
  await upsertEmbedding({
    table: "code_file_embeddings",
    pkValue: codeFileId,
    embedding,
    contentHash,
    model: getEmbeddingModel(),
  });
}

export async function getCodeFileEmbedding(
  codeFileId: string,
  currentContentHash?: string
): Promise<Embedding | null> {
  return getEmbeddingFromTable({
    table: "code_file_embeddings",
    pkValue: codeFileId,
    model: getEmbeddingModel(),
    currentContentHash,
  });
}
