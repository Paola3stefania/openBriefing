/**
 * Classification configuration
 */
export interface ClassificationConfig {
  useSemantic: boolean;
}

export function getClassificationConfig(): ClassificationConfig {
  return {
    // Enable semantic classification by default if OPENAI_API_KEY is available
    // Set USE_SEMANTIC_CLASSIFICATION=false to disable
    useSemantic: process.env.USE_SEMANTIC_CLASSIFICATION !== "false" && !!process.env.OPENAI_API_KEY,
  };
}

