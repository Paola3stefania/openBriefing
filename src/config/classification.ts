/**
 * Classification configuration
 */
export interface ClassificationConfig {
  useSemantic: boolean;
}

export function getClassificationConfig(): ClassificationConfig {
  return {
    // Use semantic classification if OPENAI_API_KEY is available, unless explicitly disabled
    useSemantic: process.env.USE_SEMANTIC_CLASSIFICATION !== "false" && !!process.env.OPENAI_API_KEY,
  };
}

