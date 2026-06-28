/**
 * Project auto-detection
 *
 * Determines a stable project identifier from the environment:
 *   1. OPENBRIEFING_PROJECT env var  (explicit override)
 *   2. git remote origin  (owner/repo)
 *   3. GITHUB_OWNER + GITHUB_REPO env vars
 *   4. basename of cwd
 *
 * NOTE: When running as an MCP server, git remote detects this repo —
 * not the agent's workspace. Agents should pass `project` explicitly.
 * This detection is a fallback for CLI scripts running inside a project.
 *
 * The result is cached for the lifetime of the process.
 */

import { execSync } from "child_process";
import { basename } from "path";

let cachedProjectId: string | undefined;

/**
 * Parse "owner/repo" from a git remote URL.
 * Handles HTTPS, SSH, and git:// formats.
 */
function parseOwnerRepo(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const match = trimmed.match(/[:\/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function detectFromGitRemote(): string | null {
  try {
    const remote = execSync("git remote get-url origin", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!remote) return null;
    return parseOwnerRepo(remote);
  } catch {
    return null;
  }
}

function detectFromEnv(): string | null {
  const explicit = process.env.OPENBRIEFING_PROJECT;
  if (explicit) return explicit;

  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (owner && repo) return `${owner}/${repo}`;
  if (repo) return repo;
  return null;
}

function detectFromCwd(): string {
  return basename(process.cwd());
}

/**
 * Detect the current project identifier.
 * Result is cached — safe to call repeatedly.
 */
export function detectProjectId(): string {
  if (cachedProjectId !== undefined) return cachedProjectId;

  const id = detectFromEnv() ?? detectFromGitRemote() ?? detectFromCwd();
  cachedProjectId = id;
  return id;
}

/**
 * Override the cached project ID (useful for tests or explicit configuration).
 */
export function setProjectId(id: string): void {
  cachedProjectId = id;
}

/**
 * Clear the cached project ID so the next call re-detects.
 */
export function resetProjectId(): void {
  cachedProjectId = undefined;
}

/**
 * Per-project local repository paths, parsed from the optional `PROJECT_REPOS`
 * env var (JSON map of project id → absolute repo path). Mirrors the
 * `PROJECT_DISCORD_GUILDS` pattern. Lets one OpenBriefing server index code for
 * several projects (e.g. `better-auth/better-auth` AND `better-auth/idp`)
 * without the single global `LOCAL_REPO_PATH` having to be re-pointed.
 *
 * Example:
 *   PROJECT_REPOS='{"better-auth/idp":"/Users/me/Better Auth/idp"}'
 */
export function getProjectRepos(): Record<string, string> {
  const raw = process.env.PROJECT_REPOS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the local repo path to index for a project.
 * Precedence: explicit override (tool arg) → PROJECT_REPOS[project] →
 * global LOCAL_REPO_PATH. Returns undefined if none apply (caller then falls
 * back to the GitHub API via GITHUB_REPO_URL).
 */
export function resolveRepoPathForProject(projectId: string, override?: string): string | undefined {
  if (override && override.trim().length > 0) return override.trim();
  const map = getProjectRepos();
  if (map[projectId]) return map[projectId];
  return process.env.LOCAL_REPO_PATH?.trim() || undefined;
}
