/**
 * Linear Status Sync
 * Syncs GitHub issue states with Linear tickets
 * One-way sync: GitHub -> Linear
 * 
 * Logic:
 * 1. Get all open Linear tickets (state != done/canceled)
 * 2. For each ticket, find connected GitHub issues and PRs
 * 3. Mark as Done if:
 *    - ALL connected GitHub issues are closed, OR
 *    - ANY PR in description is merged
 */

import { PrismaClient } from "@prisma/client";
import { LinearIntegration } from "../export/linear/client.js";
import { log, logError } from "../mcp/logger.js";
import { getConfig } from "../config/index.js";
import { GitHubTokenManager } from "../connectors/github/tokenManager.js";

// ============================================================================
// Constants
// ============================================================================

const ISSUE_STATES = {
  OPEN: "open",
  CLOSED: "closed",
  UNKNOWN: "unknown",
} as const;

const LINEAR_STATUS = {
  DONE: "done",
  PENDING: "pending",
} as const;

const SYNC_ACTIONS = {
  MARKED_DONE: "marked_done",
  UNCHANGED: "unchanged",
  SKIPPED: "skipped",
  ERROR: "error",
} as const;

const BATCH_SIZE = 50; // For batching API calls
const CONCURRENCY_LIMIT = 5; // Max parallel API calls

// ============================================================================
// Types
// ============================================================================

export interface SyncSummary {
  totalLinearTickets: number;
  synced: number;
  markedDone: number;
  skippedNoLinks: number;
  unchanged: number;
  errors: number;
  unarchivedCount: number;
  details: SyncDetail[];
}

interface SyncDetail {
    linearIdentifier: string;
  action: typeof SYNC_ACTIONS[keyof typeof SYNC_ACTIONS];
    reason: string;
    githubIssues: Array<{ number: number; state: string }>;
    prs: Array<{ url: string; merged: boolean }>;
}

interface GitHubIssueUrl {
  owner: string;
  repo: string;
  number: number;
}

interface GitHubPRUrl extends GitHubIssueUrl {
  url: string;
}

interface LinearConfig {
  apiKey: string;
  teamId: string;
  apiUrl: string;
}

interface SyncOptions {
  dryRun?: boolean;
  force?: boolean;
}

interface SyncDependencies {
  prisma: PrismaClient;
  linear: LinearIntegration;
  linearConfig: LinearConfig;
  tokenManager: GitHubTokenManager | null;
  config: ReturnType<typeof getConfig>;
}

// ============================================================================
// URL Extraction Utilities
// ============================================================================

const GITHUB_ISSUE_PATTERN = /https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/g;
const GITHUB_PR_PATTERN = /https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/g;

function extractGitHubIssueUrls(text: string): GitHubIssueUrl[] {
  const results: GitHubIssueUrl[] = [];
  let match;
  
  // Reset regex state
  GITHUB_ISSUE_PATTERN.lastIndex = 0;
  
  while ((match = GITHUB_ISSUE_PATTERN.exec(text)) !== null) {
    results.push({
      owner: match[1],
      repo: match[2],
      number: parseInt(match[3], 10),
    });
  }
  
  return results;
}

function extractGitHubPRUrls(text: string): GitHubPRUrl[] {
  const results: GitHubPRUrl[] = [];
  let match;
  
  // Reset regex state
  GITHUB_PR_PATTERN.lastIndex = 0;
  
  while ((match = GITHUB_PR_PATTERN.exec(text)) !== null) {
    results.push({
      owner: match[1],
      repo: match[2],
      number: parseInt(match[3], 10),
      url: match[0],
    });
  }
  
  return results;
}

// ============================================================================
// GitHub API Utilities
// ============================================================================

async function checkPRMerged(
  owner: string,
  repo: string,
  prNumber: number,
  tokenManager: GitHubTokenManager
): Promise<{ merged: boolean; state: string }> {
  try {
    const token = await tokenManager.getCurrentToken();
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${token}`,
        },
      }
    );
    
    tokenManager.updateRateLimitFromResponse(response, token);
    
    if (!response.ok) {
      if (response.status === 404) {
        return { merged: false, state: "not_found" };
      }
      return { merged: false, state: "error" };
    }
    
    const pr = await response.json() as { merged: boolean; state: string };
    return { merged: pr.merged, state: pr.state };
  } catch (error) {
    logError(`Failed to check PR #${prNumber}:`, error);
    return { merged: false, state: "error" };
  }
}

// ============================================================================
// Linear API Utilities
// ============================================================================

async function checkAndUnarchiveIssue(
  linearId: string,
  linearConfig: LinearConfig,
  linear: LinearIntegration
): Promise<boolean> {
  try {
    const checkQuery = `
      query CheckIssueArchived($id: String!) {
        issue(id: $id) {
          id
          archivedAt
          project { id }
          cycle { id }
        }
      }
    `;
    
    const checkResponse = await fetch(linearConfig.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: linearConfig.apiKey,
      },
      body: JSON.stringify({ 
        query: checkQuery,
        variables: { id: linearId }
      }),
    });
    
    const checkData = await checkResponse.json();
    const issue = checkData.data?.issue;
    
    if (!issue?.archivedAt) {
      return false; // Not archived, nothing to do
    }
    
    // Remove problematic project/cycle before unarchiving
    if (issue.project || issue.cycle) {
      try {
        const updateInput: Record<string, unknown> = {};
        if (issue.project) updateInput.projectId = null;
        if (issue.cycle) updateInput.cycleId = null;
        await linear.updateIssue(linearId, updateInput as any);
      } catch (e) {
        log(`[Sync] Warning: Could not remove project/cycle from ${linearId}`);
      }
    }
    
    // Unarchive the issue
    const unarchiveQuery = `
      mutation UnarchiveIssue($id: String!) {
        issueUnarchive(id: $id) {
          success
        }
      }
    `;
    
    const response = await fetch(linearConfig.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: linearConfig.apiKey,
      },
      body: JSON.stringify({ 
        query: unarchiveQuery,
        variables: { id: linearId }
      }),
    });
    
    const data = await response.json();
    return data.data?.issueUnarchive?.success === true;
  } catch (error) {
    logError(`[Sync] Error checking/unarchiving issue ${linearId}:`, error);
    return false;
  }
}

// ============================================================================
// Batch Processing Utilities
// ============================================================================

async function processInBatches<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrencyLimit: number = CONCURRENCY_LIMIT
): Promise<R[]> {
  const results: R[] = [];
  
  for (let i = 0; i < items.length; i += concurrencyLimit) {
    const batch = items.slice(i, i + concurrencyLimit);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  
  return results;
}

// ============================================================================
// Sync Logic - Separated into focused functions
// ============================================================================

async function unarchiveExportedIssues(
  deps: SyncDependencies
): Promise<number> {
  const { prisma, linear, linearConfig } = deps;
  
  log(`[Sync] Checking for archived exported issues...`);
  
  const [exportedIssues, exportedGroups] = await Promise.all([
    prisma.gitHubIssue.findMany({
      where: { linearIssueId: { not: null } },
      select: { linearIssueId: true },
    }),
    prisma.group.findMany({
      where: { linearIssueId: { not: null } },
      select: { linearIssueId: true },
    }),
  ]);
  
  const allExportedIds = [
    ...exportedIssues.map(i => i.linearIssueId).filter((id): id is string => id !== null),
    ...exportedGroups.map(g => g.linearIssueId).filter((id): id is string => id !== null),
  ];
  
  if (allExportedIds.length === 0) {
    return 0;
  }
  
  // Process in batches to avoid rate limits
  const results = await processInBatches(
    allExportedIds,
    (id) => checkAndUnarchiveIssue(id, linearConfig, linear),
    CONCURRENCY_LIMIT
  );
  
  const unarchivedCount = results.filter(Boolean).length;
  
  if (unarchivedCount > 0) {
    log(`[Sync] Unarchived ${unarchivedCount} exported issues`);
  }
  
  return unarchivedCount;
}

async function getIssueStatesFromDB(
  issueNumbers: number[],
  dbIssues: Array<{ issueNumber: number; issueState: string | null }>,
  prisma: PrismaClient
): Promise<Array<{ number: number; state: string }>> {
  const issueStates: Array<{ number: number; state: string }> = [];
  
  for (const issueNumber of issueNumbers) {
    // First check the already-fetched DB issues
    const dbIssue = dbIssues.find(i => i.issueNumber === issueNumber);
    if (dbIssue) {
      issueStates.push({
        number: issueNumber,
        state: dbIssue.issueState || ISSUE_STATES.UNKNOWN,
      });
      continue;
    }
    
    // Check DB for issues from URL extraction
    const cachedIssue = await prisma.gitHubIssue.findUnique({
      where: { issueNumber },
      select: { issueState: true },
    });
    
    issueStates.push({
      number: issueNumber,
      state: cachedIssue?.issueState || ISSUE_STATES.UNKNOWN,
    });
  }
  
  return issueStates;
}

async function checkPRStates(
  prUrls: GitHubPRUrl[],
  tokenManager: GitHubTokenManager | null
): Promise<Array<{ url: string; merged: boolean }>> {
  if (prUrls.length === 0 || !tokenManager) {
    return [];
  }
  
  return processInBatches(
    prUrls,
    async (pr) => {
      const status = await checkPRMerged(pr.owner, pr.repo, pr.number, tokenManager);
      return { url: pr.url, merged: status.merged };
    },
    CONCURRENCY_LIMIT
  );
}

function shouldMarkDone(
  issueStates: Array<{ number: number; state: string }>,
  prStates: Array<{ url: string; merged: boolean }>
): { shouldMark: boolean; reason: string } {
  const hasIssues = issueStates.length > 0;
  const allIssuesClosed = hasIssues && issueStates.every(i => i.state === ISSUE_STATES.CLOSED);
  
  const hasPRs = prStates.length > 0;
  const anyPRMerged = hasPRs && prStates.some(p => p.merged);
  
  if (allIssuesClosed && anyPRMerged) {
    return {
      shouldMark: true,
      reason: `All ${issueStates.length} issues closed AND ${prStates.filter(p => p.merged).length} PR(s) merged`,
    };
  }
  
  if (allIssuesClosed) {
    return {
      shouldMark: true,
      reason: `All ${issueStates.length} GitHub issue(s) closed`,
    };
  }
  
  if (anyPRMerged) {
    return {
      shouldMark: true,
      reason: `${prStates.filter(p => p.merged).length} PR(s) merged`,
    };
  }
  
  // Not ready - build reason
  const reasons: string[] = [];
  if (hasIssues) {
    const openCount = issueStates.filter(i => i.state !== ISSUE_STATES.CLOSED).length;
    reasons.push(`${openCount}/${issueStates.length} issues still open`);
  }
  if (hasPRs && !anyPRMerged) {
    reasons.push(`0/${prStates.length} PRs merged`);
  }
  
  return {
    shouldMark: false,
    reason: reasons.join(", ") || "No closed issues or merged PRs",
  };
}

async function processTicket(
  ticket: { id: string; identifier: string; title?: string; description?: string },
  deps: SyncDependencies,
  doneStateId: string,
  dryRun: boolean
): Promise<SyncDetail> {
  const { prisma, linear, config, tokenManager } = deps;
    const identifier = ticket.identifier;
    
    try {
      const description = ticket.description || "";
      const title = ticket.title || "";
      const fullText = `${title}\n${description}`;
      
    // Find connected GitHub issues from DB
      const dbIssues = await prisma.gitHubIssue.findMany({
        where: { linearIssueId: ticket.id },
        select: {
          issueNumber: true,
          issueState: true,
          issueTitle: true,
        },
      });
      
    // Extract URLs from Linear description
      const issueUrls = extractGitHubIssueUrls(fullText);
      const prUrls = extractGitHubPRUrls(fullText);
      
      // Combine issue numbers (dedupe)
      const allIssueNumbers = new Set<number>();
      dbIssues.forEach(i => allIssueNumbers.add(i.issueNumber));
      
    // Add issues from URLs (only if from configured repo)
      for (const issueUrl of issueUrls) {
        if (issueUrl.owner === config.github.owner && issueUrl.repo === config.github.repo) {
          allIssueNumbers.add(issueUrl.number);
        }
      }
      
    // Skip if no connections
      if (allIssueNumbers.size === 0 && prUrls.length === 0) {
      return {
          linearIdentifier: identifier,
        action: SYNC_ACTIONS.SKIPPED,
          reason: "No GitHub issues or PRs linked",
          githubIssues: [],
          prs: [],
      };
    }
    
    // Get issue and PR states
    const [issueStates, prStates] = await Promise.all([
      getIssueStatesFromDB(Array.from(allIssueNumbers), dbIssues, prisma),
      checkPRStates(prUrls, tokenManager),
    ]);
    
    // Determine action
    const decision = shouldMarkDone(issueStates, prStates);
    
    if (decision.shouldMark) {
      if (!dryRun) {
        await linear.updateIssueState(ticket.id, doneStateId);
        
        // Update DB records
        await prisma.gitHubIssue.updateMany({
          where: { issueNumber: { in: dbIssues.map(i => i.issueNumber) } },
              data: {
            linearStatus: LINEAR_STATUS.DONE,
                linearStatusSyncedAt: new Date(),
              },
            });
          }
      
      log(`[Sync] ${dryRun ? "[DRY RUN] " : ""}${identifier}: -> Done (${decision.reason})`);
        
      return {
          linearIdentifier: identifier,
        action: SYNC_ACTIONS.MARKED_DONE,
        reason: dryRun ? `[DRY RUN] ${decision.reason}` : decision.reason,
          githubIssues: issueStates,
          prs: prStates,
      };
    }
    
    return {
          linearIdentifier: identifier,
      action: SYNC_ACTIONS.UNCHANGED,
      reason: decision.reason,
          githubIssues: issueStates,
          prs: prStates,
    };
      
    } catch (error) {
      logError(`[Sync] Error processing ${identifier}:`, error);
    return {
        linearIdentifier: identifier,
      action: SYNC_ACTIONS.ERROR,
        reason: error instanceof Error ? error.message : String(error),
        githubIssues: [],
        prs: [],
    };
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

export async function syncLinearStatus(options: SyncOptions = {}): Promise<SyncSummary> {
  const { dryRun = false } = options;
  
  const config = getConfig();
  const prisma = new PrismaClient();
  
  try {
    // Validate configuration
    const linearConfig: LinearConfig = {
      apiKey: process.env.PM_TOOL_API_KEY || "",
      teamId: process.env.PM_TOOL_TEAM_ID || "",
      apiUrl: "https://api.linear.app/graphql",
    };
    
    if (!linearConfig.apiKey) {
      throw new Error("PM_TOOL_API_KEY is required for Linear sync");
    }
    
    const linear = new LinearIntegration({
      type: "linear",
      api_key: linearConfig.apiKey,
      team_id: linearConfig.teamId,
      api_url: linearConfig.apiUrl,
    });
    
    // Get workflow states
    const workflowStates = await linear.getWorkflowStates(linearConfig.teamId);
    const doneState = workflowStates.find(
      s => s.type === "completed" || s.name.toLowerCase() === "done"
    );
    
    if (!doneState) {
      throw new Error("Could not find 'Done' workflow state in Linear");
    }
    
    log(`[Sync] Found Done state: ${doneState.name} (${doneState.id})`);
    
    // Initialize token manager lazily
    const tokenManager = await GitHubTokenManager.fromEnvironment();
    
    // Build dependencies
    const deps: SyncDependencies = {
      prisma,
      linear,
      linearConfig,
      tokenManager,
      config,
    };
    
    // Step 1: Unarchive any exported issues that got archived
    const unarchivedCount = await unarchiveExportedIssues(deps);
    
    // Step 2: Get all open Linear tickets
    log(`[Sync] Fetching open Linear tickets...`);
    const openLinearTickets = await linear.getOpenIssues(linearConfig.teamId);
    log(`[Sync] Found ${openLinearTickets.length} open Linear tickets`);
    
    // Step 3: Process each ticket
    const details: SyncDetail[] = [];
    
    for (const ticket of openLinearTickets) {
      const result = await processTicket(ticket, deps, doneState.id, dryRun);
      details.push(result);
    }
    
    // Build summary
    const summary: SyncSummary = {
      totalLinearTickets: openLinearTickets.length,
      synced: details.filter(d => d.action === SYNC_ACTIONS.MARKED_DONE).length,
      markedDone: details.filter(d => d.action === SYNC_ACTIONS.MARKED_DONE).length,
      skippedNoLinks: details.filter(d => d.action === SYNC_ACTIONS.SKIPPED).length,
      unchanged: details.filter(d => d.action === SYNC_ACTIONS.UNCHANGED).length,
      errors: details.filter(d => d.action === SYNC_ACTIONS.ERROR).length,
      unarchivedCount,
      details,
    };
  
  log(`[Sync] Complete: ${summary.markedDone} marked done, ${summary.unchanged} unchanged, ${summary.skippedNoLinks} skipped (no links), ${summary.errors} errors`);
  
  return summary;
    
  } finally {
    await prisma.$disconnect();
  }
}
