/**
 * Thin embedding wrappers shared across the storage layer.
 *
 * Historically these lived in `core/classify/semantic.ts` alongside the Discord
 * classification pipeline. That pipeline moved out to the unMute project; only
 * these two provider-agnostic helpers (used by memory + embedding storage)
 * remain in openBriefing, so they live here next to `embed.ts`.
 */
import { embedText, embedTexts } from "./embed.js";

export type Embedding = number[];

/**
 * Create embeddings for multiple texts in one provider round-trip.
 * `apiKey` is threaded through for OpenAI; ignored under Ollama.
 */
export async function createEmbeddings(
  texts: string[],
  apiKey: string,
  retries = 3,
): Promise<Embedding[]> {
  return embedTexts(texts, { apiKey, retries });
}

/** Single-text variant. Prefer `createEmbeddings` for batches. */
export async function createEmbedding(
  text: string,
  apiKey: string,
  retries = 3,
): Promise<Embedding> {
  return embedText(text, { apiKey, retries });
}
