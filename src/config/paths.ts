/**
 * File paths configuration
 */
export interface PathsConfig {
  resultsDir: string;
  cacheDir: string;
  issuesCacheFile: string;
}

export function getPathsConfig(): PathsConfig {
  return {
    resultsDir: process.env.RESULTS_DIR || "results",
    cacheDir: process.env.CACHE_DIR || "cache",
    issuesCacheFile: process.env.ISSUES_CACHE_FILE || "github-issues-cache.json",
  };
}

