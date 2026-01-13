/**
 * Open PR With Fix Tool
 * 
 * Creates a draft PR with the generated fix. This tool:
 * 1. Reads project rules from LOCAL_REPO_PATH
 * 2. Creates a branch, commits changes, and pushes
 * 3. Creates a draft PR via GitHub API
 * 4. Updates Linear with the result
 * 5. Tracks the attempt in the database
 */

import { PrismaClient } from "@prisma/client";
import { getConfig } from "../config/index.js";
import { GitHubTokenManager } from "../connectors/github/tokenManager.js";
import { log, logError } from "../mcp/logger.js";
import { execSync, exec } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

export interface FileChange {
  path: string;          // File path relative to repo root
  content: string;       // New file content (full file)
  operation: "modify" | "create" | "delete";
}

export interface OpenPROptions {
  issueNumber: number;
  issueTitle: string;
  issueRepo?: string;      // Override repo (default: from config)
  triageResult: string;    // From investigate_issue
  triageConfidence: number;
  triageReasoning?: string;
  fileChanges: FileChange[];
  commitMessage: string;   // Should follow project conventions
  prTitle: string;         // Should follow project conventions
  prBody: string;          // PR description
  linearIssueId?: string;  // Optional Linear issue to update
}

export interface OpenPRResult {
  success: boolean;
  prNumber?: number;
  prUrl?: string;
  branchName?: string;
  filesChanged?: string[];
  error?: string;
  linearCommentId?: string;
}

export interface ProjectRules {
  baseBranch: string;           // Default: "main" or "canary"
  branchNaming: string;         // Pattern for branch names
  commitFormat: string;         // Commit message format
  prTitleFormat: string;        // PR title format
  types: string[];              // Allowed types: fix, feat, etc.
  subsystems: string[];         // Project-specific subsystems
  codeStyle?: string[];         // Additional code style rules
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_RULES: ProjectRules = {
  baseBranch: "main",
  branchNaming: "{type}/{issue}-{description}",
  commitFormat: "{type}({scope}): {description}",
  prTitleFormat: "{type}({scope}): {description}",
  types: ["fix", "feat", "docs", "refactor", "test", "chore"],
  subsystems: [],
};

const MAX_FILES_CHANGED = 15;
const MAX_LINES_CHANGED = 1000;

// ============================================================================
// Project Rules Discovery
// ============================================================================

/**
 * Discover project rules from the local repository
 */
export function discoverProjectRules(repoPath: string): ProjectRules {
  const rules: ProjectRules = { ...DEFAULT_RULES };
  
  // Search order for rules
  const rulePaths = [
    join(repoPath, ".cursor", "rules"),
    join(repoPath, ".cursor", "rules.mdc"),
    join(repoPath, ".cursorrules"),
    join(repoPath, "CONTRIBUTING.md"),
  ];
  
  let rulesContent: string | null = null;
  
  for (const rulePath of rulePaths) {
    if (existsSync(rulePath)) {
      try {
        rulesContent = readFileSync(rulePath, "utf-8");
        log(`[Rules] Found project rules at: ${rulePath}`);
        break;
      } catch {
        continue;
      }
    }
  }
  
  if (!rulesContent) {
    log(`[Rules] No project rules found, using defaults`);
    return rules;
  }
  
  // Parse rules content
  try {
    // Check for base branch
    const baseBranchMatch = rulesContent.match(/base\s*(?:branch)?[:\s]+[`"']?(main|master|canary|develop)[`"']?/i);
    if (baseBranchMatch) {
      rules.baseBranch = baseBranchMatch[1].toLowerCase();
    }
    
    // Check for branch naming pattern
    const branchMatch = rulesContent.match(/branch\s*(?:naming|format)?[:\s]+[`"']?([^`"'\n]+)[`"']?/i);
    if (branchMatch) {
      rules.branchNaming = branchMatch[1].trim();
    }
    
    // Check for commit format
    const commitMatch = rulesContent.match(/commit\s*(?:message|format)?[:\s]+[`"']?([^`"'\n]+)[`"']?/i);
    if (commitMatch) {
      rules.commitFormat = commitMatch[1].trim();
    }
    
    // Check for PR title format
    const prTitleMatch = rulesContent.match(/(?:pr|pull\s*request)\s*(?:title|format)?[:\s]+[`"']?([^`"'\n]+)[`"']?/i);
    if (prTitleMatch) {
      rules.prTitleFormat = prTitleMatch[1].trim();
    }
    
    // Check for types
    const typesMatch = rulesContent.match(/types?[:\s]+\[([^\]]+)\]/i);
    if (typesMatch) {
      rules.types = typesMatch[1].split(",").map(t => t.trim().replace(/[`"']/g, "")).filter(Boolean);
    }
    
    // Check for subsystems/scopes
    const subsystemsMatch = rulesContent.match(/(?:subsystems?|scopes?)[:\s]+\[([^\]]+)\]/i);
    if (subsystemsMatch) {
      rules.subsystems = subsystemsMatch[1].split(",").map(t => t.trim().replace(/[`"']/g, "")).filter(Boolean);
    }
    
    // Extract code style rules
    const codeStyleRules: string[] = [];
    if (/no\s*inline\s*comments?/i.test(rulesContent)) {
      codeStyleRules.push("no-inline-comments");
    }
    if (/use\s*(?:internal|shared)\s*utilities/i.test(rulesContent)) {
      codeStyleRules.push("use-internal-utils");
    }
    if (/no\s*(?:any|unknown)\s*types?/i.test(rulesContent)) {
      codeStyleRules.push("no-any-types");
    }
    if (codeStyleRules.length > 0) {
      rules.codeStyle = codeStyleRules;
    }
    
  } catch (error) {
    logError("[Rules] Failed to parse project rules:", error);
  }
  
  log(`[Rules] Discovered: base=${rules.baseBranch}, types=${rules.types.join(",")}`);
  return rules;
}

// ============================================================================
// Git Operations
// ============================================================================

/**
 * Generate branch name from pattern
 */
function generateBranchName(
  pattern: string,
  type: string,
  issueNumber: number,
  description: string
): string {
  const sanitizedDesc = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
  
  return pattern
    .replace("{type}", type)
    .replace("{issue}", issueNumber.toString())
    .replace("{description}", sanitizedDesc);
}

/**
 * Execute git command in repo
 */
async function gitExec(repoPath: string, command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(`git ${command}`, {
      cwd: repoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (stderr && !stderr.includes("Already on") && !stderr.includes("Switched to")) {
      log(`[Git] stderr: ${stderr}`);
    }
    return stdout.trim();
  } catch (error) {
    const execError = error as { stderr?: string; stdout?: string; message: string };
    throw new Error(`Git command failed: ${command}\n${execError.stderr || execError.message}`);
  }
}

/**
 * Create branch, commit changes, and push
 */
async function createBranchAndCommit(
  repoPath: string,
  branchName: string,
  baseBranch: string,
  fileChanges: FileChange[],
  commitMessage: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Ensure we're on the base branch and up to date
    log(`[Git] Fetching latest from origin...`);
    await gitExec(repoPath, "fetch origin");
    
    log(`[Git] Checking out ${baseBranch}...`);
    await gitExec(repoPath, `checkout ${baseBranch}`);
    
    log(`[Git] Pulling latest changes...`);
    await gitExec(repoPath, `pull origin ${baseBranch}`);
    
    // Check if branch already exists
    try {
      await gitExec(repoPath, `rev-parse --verify ${branchName}`);
      log(`[Git] Branch ${branchName} already exists, deleting...`);
      await gitExec(repoPath, `branch -D ${branchName}`);
    } catch {
      // Branch doesn't exist, which is fine
    }
    
    // Create new branch
    log(`[Git] Creating branch ${branchName}...`);
    await gitExec(repoPath, `checkout -b ${branchName}`);
    
    // Apply file changes
    for (const change of fileChanges) {
      const filePath = join(repoPath, change.path);
      
      if (change.operation === "delete") {
        if (existsSync(filePath)) {
          log(`[Git] Deleting file: ${change.path}`);
          await gitExec(repoPath, `rm "${change.path}"`);
        }
      } else {
        // Create or modify
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
          log(`[Git] Creating directory: ${dir}`);
          mkdirSync(dir, { recursive: true });
        }
        
        log(`[Git] Writing file: ${change.path}`);
        writeFileSync(filePath, change.content, "utf-8");
        await gitExec(repoPath, `add "${change.path}"`);
      }
    }
    
    // Commit changes
    log(`[Git] Committing changes...`);
    await gitExec(repoPath, `commit -m "${commitMessage.replace(/"/g, '\\"')}"`);
    
    // Push branch
    log(`[Git] Pushing branch to origin...`);
    await gitExec(repoPath, `push -u origin ${branchName}`);
    
    // Return to base branch
    await gitExec(repoPath, `checkout ${baseBranch}`);
    
    return { success: true };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logError("[Git] Operation failed:", error);
    
    // Try to recover - go back to base branch
    try {
      await gitExec(repoPath, `checkout ${baseBranch}`);
    } catch {
      // Ignore recovery errors
    }
    
    return { success: false, error: errorMsg };
  }
}

// ============================================================================
// GitHub API
// ============================================================================

/**
 * Create a draft PR via GitHub API
 */
async function createDraftPR(
  tokenManager: GitHubTokenManager,
  owner: string,
  repo: string,
  branchName: string,
  baseBranch: string,
  title: string,
  body: string
): Promise<{ prNumber: number; prUrl: string } | null> {
  const token = await tokenManager.getCurrentToken();
  
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        body,
        head: branchName,
        base: baseBranch,
        draft: true,
      }),
    }
  );
  
  tokenManager.updateRateLimitFromResponse(response, token);
  
  if (!response.ok) {
    const errorBody = await response.text();
    logError(`[GitHub] Failed to create PR: ${response.status} ${errorBody}`);
    return null;
  }
  
  const pr = await response.json() as { number: number; html_url: string };
  return { prNumber: pr.number, prUrl: pr.html_url };
}

// ============================================================================
// Linear Integration
// ============================================================================

/**
 * Add a comment to a Linear issue about the PR
 */
async function addLinearComment(
  linearApiKey: string,
  issueId: string,
  prNumber: number,
  prUrl: string,
  issueNumber: number
): Promise<string | null> {
  const commentBody = `**Automated Fix PR Created**

A draft PR has been opened to address this issue:

- **GitHub Issue:** #${issueNumber}
- **PR:** [#${prNumber}](${prUrl})

Please review the PR and merge if the fix is correct.`;

  try {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: linearApiKey,
      },
      body: JSON.stringify({
        query: `
          mutation CreateComment($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) {
              success
              comment {
                id
              }
            }
          }
        `,
        variables: { issueId, body: commentBody },
      }),
    });

    if (!response.ok) {
      logError(`[Linear] Failed to add comment: ${response.status}`);
      return null;
    }

    const result = await response.json() as {
      data?: { commentCreate?: { success: boolean; comment?: { id: string } } };
    };
    
    return result.data?.commentCreate?.comment?.id || null;
  } catch (error) {
    logError("[Linear] Failed to add comment:", error);
    return null;
  }
}

/**
 * Add a "no fix" comment to a Linear issue
 */
async function addLinearNoFixComment(
  linearApiKey: string,
  issueId: string,
  issueNumber: number,
  reason: string
): Promise<string | null> {
  const commentBody = `**Automated Fix Not Created**

The system investigated GitHub issue #${issueNumber} but could not create a fix.

**Reason:** ${reason}

Manual investigation may be required.`;

  try {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: linearApiKey,
      },
      body: JSON.stringify({
        query: `
          mutation CreateComment($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) {
              success
              comment {
                id
              }
            }
          }
        `,
        variables: { issueId, body: commentBody },
      }),
    });

    if (!response.ok) {
      logError(`[Linear] Failed to add no-fix comment: ${response.status}`);
      return null;
    }

    const result = await response.json() as {
      data?: { commentCreate?: { success: boolean; comment?: { id: string } } };
    };
    
    return result.data?.commentCreate?.comment?.id || null;
  } catch (error) {
    logError("[Linear] Failed to add no-fix comment:", error);
    return null;
  }
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate the fix doesn't exceed limits
 */
function validateFix(fileChanges: FileChange[]): { valid: boolean; error?: string } {
  // Check file count
  if (fileChanges.length > MAX_FILES_CHANGED) {
    return {
      valid: false,
      error: `Too many files changed: ${fileChanges.length} (max: ${MAX_FILES_CHANGED})`,
    };
  }
  
  // Check total lines changed
  let totalLines = 0;
  for (const change of fileChanges) {
    if (change.operation !== "delete") {
      totalLines += change.content.split("\n").length;
    }
  }
  
  if (totalLines > MAX_LINES_CHANGED) {
    return {
      valid: false,
      error: `Too many lines changed: ${totalLines} (max: ${MAX_LINES_CHANGED})`,
    };
  }
  
  // Validate file paths (no path traversal)
  for (const change of fileChanges) {
    if (change.path.includes("..") || change.path.startsWith("/")) {
      return {
        valid: false,
        error: `Invalid file path: ${change.path}`,
      };
    }
  }
  
  return { valid: true };
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Open a PR with the generated fix
 */
export async function openPRWithFix(options: OpenPROptions): Promise<OpenPRResult> {
  const {
    issueNumber,
    issueTitle,
    issueRepo,
    triageResult,
    triageConfidence,
    triageReasoning,
    fileChanges,
    commitMessage,
    prTitle,
    prBody,
    linearIssueId,
  } = options;
  
  const config = getConfig();
  const prisma = new PrismaClient();
  
  // Determine repo
  let owner: string;
  let repoName: string;
  
  if (issueRepo) {
    const parts = issueRepo.split("/");
    if (parts.length !== 2) {
      return { success: false, error: `Invalid repo format: ${issueRepo}` };
    }
    owner = parts[0];
    repoName = parts[1];
  } else {
    owner = config.github.owner;
    repoName = config.github.repo;
  }
  
  const fullRepo = `${owner}/${repoName}`;
  
  try {
    log(`[OpenPR] Opening PR for issue #${issueNumber} in ${fullRepo}...`);
    
    // Check for LOCAL_REPO_PATH
    const localRepoPath = process.env.LOCAL_REPO_PATH;
    if (!localRepoPath) {
      return {
        success: false,
        error: "LOCAL_REPO_PATH environment variable is required for creating PRs",
      };
    }
    
    if (!existsSync(localRepoPath)) {
      return {
        success: false,
        error: `LOCAL_REPO_PATH does not exist: ${localRepoPath}`,
      };
    }
    
    // Validate fix
    const validation = validateFix(fileChanges);
    if (!validation.valid) {
      // Record failed attempt
      await prisma.fixAttempt.upsert({
        where: {
          issueNumber_issueRepo: { issueNumber, issueRepo: fullRepo },
        },
        create: {
          issueNumber,
          issueRepo: fullRepo,
          issueTitle,
          triageResult,
          triageConfidence,
          triageReasoning,
          fixAttempted: false,
          noFixReason: validation.error,
          linearIssueId,
        },
        update: {
          triageResult,
          triageConfidence,
          triageReasoning,
          fixAttempted: false,
          noFixReason: validation.error,
        },
      });
      
      return { success: false, error: validation.error };
    }
    
    // Discover project rules
    const rules = discoverProjectRules(localRepoPath);
    
    // Generate branch name
    const branchName = generateBranchName(
      rules.branchNaming,
      "fix",
      issueNumber,
      issueTitle
    );
    
    // Initialize token manager
    const tokenManager = await GitHubTokenManager.fromEnvironment();
    if (!tokenManager) {
      return {
        success: false,
        error: "GitHub token is required. Set GITHUB_TOKEN environment variable.",
      };
    }
    
    // Create branch and commit
    log(`[OpenPR] Creating branch ${branchName}...`);
    const gitResult = await createBranchAndCommit(
      localRepoPath,
      branchName,
      rules.baseBranch,
      fileChanges,
      commitMessage
    );
    
    if (!gitResult.success) {
      // Record failed attempt
      await prisma.fixAttempt.upsert({
        where: {
          issueNumber_issueRepo: { issueNumber, issueRepo: fullRepo },
        },
        create: {
          issueNumber,
          issueRepo: fullRepo,
          issueTitle,
          triageResult,
          triageConfidence,
          triageReasoning,
          fixAttempted: true,
          fixSucceeded: false,
          branchName,
          noFixReason: `Git error: ${gitResult.error}`,
          linearIssueId,
        },
        update: {
          triageResult,
          triageConfidence,
          triageReasoning,
          fixAttempted: true,
          fixSucceeded: false,
          branchName,
          noFixReason: `Git error: ${gitResult.error}`,
        },
      });
      
      return { success: false, error: gitResult.error, branchName };
    }
    
    // Create draft PR
    log(`[OpenPR] Creating draft PR...`);
    const prResult = await createDraftPR(
      tokenManager,
      owner,
      repoName,
      branchName,
      rules.baseBranch,
      prTitle,
      prBody
    );
    
    if (!prResult) {
      // Record failed attempt
      await prisma.fixAttempt.upsert({
        where: {
          issueNumber_issueRepo: { issueNumber, issueRepo: fullRepo },
        },
        create: {
          issueNumber,
          issueRepo: fullRepo,
          issueTitle,
          triageResult,
          triageConfidence,
          triageReasoning,
          fixAttempted: true,
          fixSucceeded: false,
          branchName,
          noFixReason: "Failed to create GitHub PR",
          linearIssueId,
        },
        update: {
          triageResult,
          triageConfidence,
          triageReasoning,
          fixAttempted: true,
          fixSucceeded: false,
          branchName,
          noFixReason: "Failed to create GitHub PR",
        },
      });
      
      return {
        success: false,
        error: "Failed to create draft PR on GitHub",
        branchName,
      };
    }
    
    log(`[OpenPR] Created PR #${prResult.prNumber}: ${prResult.prUrl}`);
    
    // Update Linear if configured
    let linearCommentId: string | undefined;
    const linearApiKey = process.env.PM_TOOL_API_KEY;
    
    if (linearApiKey && linearIssueId) {
      log(`[OpenPR] Adding comment to Linear issue ${linearIssueId}...`);
      const commentId = await addLinearComment(
        linearApiKey,
        linearIssueId,
        prResult.prNumber,
        prResult.prUrl,
        issueNumber
      );
      if (commentId) {
        linearCommentId = commentId;
      }
    }
    
    // Record successful attempt
    const filesChanged = fileChanges.map(f => f.path);
    await prisma.fixAttempt.upsert({
      where: {
        issueNumber_issueRepo: { issueNumber, issueRepo: fullRepo },
      },
      create: {
        issueNumber,
        issueRepo: fullRepo,
        issueTitle,
        triageResult,
        triageConfidence,
        triageReasoning,
        fixAttempted: true,
        fixSucceeded: true,
        prNumber: prResult.prNumber,
        prUrl: prResult.prUrl,
        prTitle,
        branchName,
        filesChanged,
        linearIssueId,
        linearCommentId,
        linearUpdated: !!linearCommentId,
      },
      update: {
        triageResult,
        triageConfidence,
        triageReasoning,
        fixAttempted: true,
        fixSucceeded: true,
        prNumber: prResult.prNumber,
        prUrl: prResult.prUrl,
        prTitle,
        branchName,
        filesChanged,
        linearCommentId,
        linearUpdated: !!linearCommentId,
      },
    });
    
    return {
      success: true,
      prNumber: prResult.prNumber,
      prUrl: prResult.prUrl,
      branchName,
      filesChanged,
      linearCommentId,
    };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logError("[OpenPR] Failed:", error);
    
    // Try to record the failed attempt
    try {
      await prisma.fixAttempt.upsert({
        where: {
          issueNumber_issueRepo: { issueNumber, issueRepo: fullRepo },
        },
        create: {
          issueNumber,
          issueRepo: fullRepo,
          issueTitle,
          triageResult,
          triageConfidence,
          triageReasoning,
          fixAttempted: true,
          fixSucceeded: false,
          noFixReason: errorMsg,
          linearIssueId,
        },
        update: {
          triageResult,
          triageConfidence,
          triageReasoning,
          fixAttempted: true,
          fixSucceeded: false,
          noFixReason: errorMsg,
        },
      });
    } catch {
      // Ignore database errors during error handling
    }
    
    return { success: false, error: errorMsg };
    
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Record a "no fix" decision (when fix is not attempted)
 */
export async function recordNoFix(
  issueNumber: number,
  issueTitle: string,
  issueRepo: string,
  triageResult: string,
  triageConfidence: number,
  triageReasoning: string | undefined,
  reason: string,
  linearIssueId?: string
): Promise<void> {
  const prisma = new PrismaClient();
  
  try {
    await prisma.fixAttempt.upsert({
      where: {
        issueNumber_issueRepo: { issueNumber, issueRepo },
      },
      create: {
        issueNumber,
        issueRepo,
        issueTitle,
        triageResult,
        triageConfidence,
        triageReasoning,
        fixAttempted: false,
        noFixReason: reason,
        linearIssueId,
      },
      update: {
        triageResult,
        triageConfidence,
        triageReasoning,
        fixAttempted: false,
        noFixReason: reason,
      },
    });
    
    // Add comment to Linear if configured
    const linearApiKey = process.env.PM_TOOL_API_KEY;
    if (linearApiKey && linearIssueId) {
      await addLinearNoFixComment(linearApiKey, linearIssueId, issueNumber, reason);
    }
    
  } finally {
    await prisma.$disconnect();
  }
}
