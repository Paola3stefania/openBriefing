/**
 * Classification configuration.
 *
 * Embedding generation runs through one of two providers:
 *  - "ollama" (default): local Ollama daemon, no API key, no per-token cost.
 *    Model defaults to `mxbai-embed-large` (1024 dim, retrieval-tuned).
 *  - "openai": OpenAI's embeddings API. Requires OPENAI_API_KEY.
 *
 * Whichever provider is selected, the rest of the system reads embeddings
 * through `EMBEDDING_DIM` in src/storage/db/vector.ts; that dim must match
 * the model's output, otherwise the runtime check in src/embeddings/embed.ts
 * throws a clear error.
 */
export interface ClassificationConfig {
  useSemantic: boolean;
  embeddingModel: string;
  embeddingProvider: "ollama" | "openai";
}

export function getEmbeddingProvider(): "ollama" | "openai" {
  return (process.env.EMBEDDING_PROVIDER ?? "ollama").toLowerCase() === "openai"
    ? "openai"
    : "ollama";
}

/**
 * Human-readable model identifier we persist alongside every embedding row.
 * For Ollama, this is whatever `OLLAMA_EMBEDDING_MODEL` is set to (any model
 * the user has pulled). For OpenAI, we keep the legacy validation against
 * the three known model names.
 */
export function getEmbeddingModel(): string {
  if (getEmbeddingProvider() === "ollama") {
    return process.env.OLLAMA_EMBEDDING_MODEL ?? "mxbai-embed-large";
  }
  const model = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
  const valid = [
    "text-embedding-3-small",
    "text-embedding-3-large",
    "text-embedding-ada-002",
  ];
  if (!valid.includes(model)) {
    console.warn(`[Config] Invalid OpenAI embedding model "${model}", using "text-embedding-3-small"`);
    return "text-embedding-3-small";
  }
  return model;
}

export function getClassificationConfig(): ClassificationConfig {
  const provider = getEmbeddingProvider();
  return {
    // With Ollama, semantic is on by default (no API key needed). With
    // OpenAI, gate on OPENAI_API_KEY presence.
    useSemantic:
      process.env.USE_SEMANTIC_CLASSIFICATION !== "false" &&
      (provider === "ollama" || !!process.env.OPENAI_API_KEY),
    embeddingModel: getEmbeddingModel(),
    embeddingProvider: provider,
  };
}
