/**
 * Classification configuration
 */
export interface ClassificationConfig {
  useSemantic: boolean;
  embeddingModel: string;
}

/**
 * Get the embedding model to use
 * Available models:
 * - text-embedding-3-small: Fast, cost-effective (default, 1536 dimensions)
 * - text-embedding-3-large: Higher quality, more expensive (3072 dimensions)
 * - text-embedding-ada-002: Legacy model (1536 dimensions)
 */
export function getEmbeddingModel(): string {
  const model = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
  
  // Validate model name
  const validModels = [
    "text-embedding-3-small",
    "text-embedding-3-large", 
    "text-embedding-ada-002"
  ];
  
  if (!validModels.includes(model)) {
    console.warn(`[Config] Invalid embedding model "${model}", using default "text-embedding-3-small"`);
    return "text-embedding-3-small";
  }
  
  return model;
}

export function getClassificationConfig(): ClassificationConfig {
  return {
    // Enable semantic classification by default if OPENAI_API_KEY is available
    // Set USE_SEMANTIC_CLASSIFICATION=false to disable
    useSemantic: process.env.USE_SEMANTIC_CLASSIFICATION !== "false" && !!process.env.OPENAI_API_KEY,
    embeddingModel: getEmbeddingModel(),
  };
}

