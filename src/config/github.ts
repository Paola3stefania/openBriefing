/**
 * GitHub-specific configuration
 */
export interface GitHubConfig {
  owner: string;
  repo: string;
}

export function getGitHubConfig(): GitHubConfig {
  return {
    owner: process.env.GITHUB_OWNER || "",
    repo: process.env.GITHUB_REPO || "",
  };
}

