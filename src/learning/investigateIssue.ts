/**
 * Investigate Issue Tool
 * 
 * Gathers full issue context, triages the issue type (bug vs config vs feature),
 * and finds similar historical fixes from the PRLearning table.
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { getConfig } from "../config/index.js";
import { GitHubTokenManager } from "../connectors/github/tokenManager.js";
import { log, logError } from "../mcp/logger.js";
import { createHash } from "crypto";

// ============================================================================
// Types
// ============================================================================

export interface InvestigateOptions {
  issueNumber: number;
  repo?: string;          // Override repo (default: from config)
  includeDiscord?: boolean; // Include matched Discord threads
  maxSimilarFixes?: number; // Max similar fixes to return (default: 5)
}

export type TriageResult = "bug" | "config" | "feature" | "question" | "unclear";

export interface TriageOutput {
  result: TriageResult;
  confidence: number;     // 0.0 - 1.0
  reasoning: string;
  factors: TriageFactor[];
}

export interface TriageFactor {
  factor: string;
  weight: number;
  matched: boolean;
  detail?: string;
}

export interface SimilarFix {
  issueNumber: number;
  issueTitle: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  prDiff: string;         // Truncated diff
  prFilesChanged: string[];
  issueType: string;
  subsystem: string | null;
  fixPatterns: string[];
  similarity: number;     // 0.0 - 1.0
}

export interface IssueContext {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  state: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  comments: IssueComment[];
  reactions: IssueReactions | null;
  assignees: string[];
  milestone: string | null;
  linkedPRs: LinkedPR[];
  discordThreads?: DiscordThread[];
}

export interface IssueComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  isOrganizationMember?: boolean;
}

export interface IssueReactions {
  total: number;
  thumbsUp: number;
  thumbsDown: number;
  heart: number;
  confused: number;
}

export interface LinkedPR {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  url: string;
}

export interface DiscordThread {
  threadId: string;
  threadName: string;
  url?: string;
  messageCount: number;
  similarity: number;
}

export interface InvestigationResult {
  issueContext: IssueContext;
  triage: TriageOutput;
  similarFixes: SimilarFix[];
  recommendation: string;
  shouldAttemptFix: boolean;
  alreadyInvestigated: boolean;
}

// ============================================================================
// Triage Configuration
// ============================================================================

const TRIAGE_FACTORS: Array<{
  factor: string;
  weight: number;
  check: (ctx: IssueContext) => { matched: boolean; detail?: string };
}> = [
  // Bug indicators
  {
    factor: "has_bug_label",
    weight: 0.25,
    check: (ctx) => ({
      matched: ctx.labels.some(l => 
        l.toLowerCase().includes("bug") || 
        l.toLowerCase().includes("fix")
      ),
      detail: ctx.labels.find(l => l.toLowerCase().includes("bug") || l.toLowerCase().includes("fix")),
    }),
  },
  {
    factor: "error_in_title",
    weight: 0.15,
    check: (ctx) => ({
      matched: /error|exception|crash|fail|broken|issue|not work/i.test(ctx.title),
      detail: ctx.title.match(/error|exception|crash|fail|broken|issue|not work/i)?.[0],
    }),
  },
  {
    factor: "stack_trace_in_body",
    weight: 0.20,
    check: (ctx) => ({
      matched: ctx.body ? /at\s+[\w.]+\s*\(|Error:|TypeError:|ReferenceError:|SyntaxError:|throw\s+new/i.test(ctx.body) : false,
      detail: "Contains stack trace or error",
    }),
  },
  {
    factor: "reproduction_steps",
    weight: 0.15,
    check: (ctx) => ({
      matched: ctx.body ? /steps?\s+to\s+reproduce|repro|how\s+to\s+reproduce|reproduction/i.test(ctx.body) : false,
      detail: "Has reproduction steps",
    }),
  },
  {
    factor: "expected_vs_actual",
    weight: 0.10,
    check: (ctx) => ({
      matched: ctx.body ? /expected|actual|should|instead|but\s+got/i.test(ctx.body) : false,
      detail: "Describes expected vs actual behavior",
    }),
  },
  
  // Config indicators (reduces bug confidence)
  {
    factor: "config_question",
    weight: -0.20,
    check: (ctx) => ({
      matched: /how\s+(do|can|to)|where\s+(do|can|is)|what\s+(is|are)|configure|configuration|setup|setting/i.test(ctx.title + " " + (ctx.body || "")),
      detail: "Appears to be a configuration question",
    }),
  },
  {
    factor: "question_label",
    weight: -0.20,
    check: (ctx) => ({
      matched: ctx.labels.some(l => 
        l.toLowerCase().includes("question") || 
        l.toLowerCase().includes("help") ||
        l.toLowerCase().includes("support")
      ),
      detail: ctx.labels.find(l => l.toLowerCase().includes("question") || l.toLowerCase().includes("help")),
    }),
  },
  {
    factor: "missing_env_vars",
    weight: -0.15,
    check: (ctx) => ({
      matched: ctx.body ? /env|environment\s+variable|\.env|process\.env|missing\s+.*key|api\s*key/i.test(ctx.body) : false,
      detail: "Mentions environment variables",
    }),
  },
  
  // Feature indicators
  {
    factor: "feature_label",
    weight: -0.15,
    check: (ctx) => ({
      matched: ctx.labels.some(l => 
        l.toLowerCase().includes("feature") || 
        l.toLowerCase().includes("enhancement") ||
        l.toLowerCase().includes("request")
      ),
      detail: ctx.labels.find(l => l.toLowerCase().includes("feature") || l.toLowerCase().includes("enhancement")),
    }),
  },
  {
    factor: "would_be_nice",
    weight: -0.10,
    check: (ctx) => ({
      matched: /would\s+be\s+(nice|great|helpful)|feature\s+request|suggestion|propose|new\s+feature/i.test(ctx.title + " " + (ctx.body || "")),
      detail: "Contains feature request language",
    }),
  },
  
  // Code evidence (increases bug confidence)
  {
    factor: "code_snippet",
    weight: 0.10,
    check: (ctx) => ({
      matched: ctx.body ? /```[\s\S]*```/.test(ctx.body) : false,
      detail: "Contains code snippet",
    }),
  },
  {
    factor: "version_info",
    weight: 0.05,
    check: (ctx) => ({
      matched: ctx.body ? /version|v\d+\.\d+|\w+@\d/i.test(ctx.body) : false,
      detail: "Includes version information",
    }),
  },
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Wait helper
 */
async function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create embedding for similarity search
 * For now, we use a simple hash-based approach
 * In production, this would use OpenAI or similar
 */
function createSimpleEmbedding(text: string): number[] {
  const hash = createHash("sha256").update(text.toLowerCase()).digest();
  // Convert first 64 bytes to floats between -1 and 1
  const embedding: number[] = [];
  for (let i = 0; i < Math.min(64, hash.length); i++) {
    embedding.push((hash[i] / 127.5) - 1);
  }
  return embedding;
}

/**
 * Calculate cosine similarity between two embeddings
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    // Pad shorter array
    const maxLen = Math.max(a.length, b.length);
    while (a.length < maxLen) a.push(0);
    while (b.length < maxLen) b.push(0);
  }
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Truncate diff to reasonable size
 */
function truncateDiff(diff: string, maxLength: number = 3000): string {
  if (diff.length <= maxLength) return diff;
  return diff.substring(0, maxLength) + "\n\n... (truncated)";
}

// ============================================================================
// GitHub API Functions
// ============================================================================

interface GitHubIssueResponse {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
  user: { login: string };
  created_at: string;
  updated_at: string;
  html_url: string;
  assignees?: Array<{ login: string }>;
  milestone?: { title: string } | null;
  reactions?: {
    total_count: number;
    "+1": number;
    "-1": number;
    heart: number;
    confused: number;
  };
}

interface GitHubCommentResponse {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
  author_association?: string;
}

interface GitHubPRSearchItem {
  number: number;
  title: string;
  state: string;
  pull_request?: { merged_at: string | null };
  html_url: string;
}

/**
 * Fetch full issue context from GitHub
 */
async function fetchIssueContext(
  tokenManager: GitHubTokenManager,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<IssueContext> {
  const token = await tokenManager.getCurrentToken();
  
  // Fetch issue
  const issueResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
      },
    }
  );
  
  tokenManager.updateRateLimitFromResponse(issueResponse, token);
  
  if (!issueResponse.ok) {
    throw new Error(`Failed to fetch issue #${issueNumber}: ${issueResponse.status}`);
  }
  
  const issue = await issueResponse.json() as GitHubIssueResponse;
  
  // Fetch comments
  const commentsResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`,
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
      },
    }
  );
  
  tokenManager.updateRateLimitFromResponse(commentsResponse, token);
  
  const comments: IssueComment[] = [];
  if (commentsResponse.ok) {
    const rawComments = await commentsResponse.json() as GitHubCommentResponse[];
    for (const comment of rawComments) {
      comments.push({
        id: comment.id,
        author: comment.user.login,
        body: comment.body,
        createdAt: comment.created_at,
        isOrganizationMember: comment.author_association === "MEMBER" || comment.author_association === "OWNER" || comment.author_association === "COLLABORATOR",
      });
    }
  }
  
  // Search for linked PRs
  await wait(100);
  let currentToken = token;
  let prSearchResponse = await fetch(
    `https://api.github.com/search/issues?q=repo:${owner}/${repo}+type:pr+${issueNumber}&per_page=10`,
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${currentToken}`,
      },
    }
  );
  
  tokenManager.updateRateLimitFromResponse(prSearchResponse, currentToken);
  
  // Handle rate limits - Search API has 30/min limit
  if (prSearchResponse.status === 403 || prSearchResponse.status === 429) {
    const rateLimitLimit = prSearchResponse.headers.get('X-RateLimit-Limit');
    const isSearchLimit = rateLimitLimit === '30';
    
    // Try rotating to another token
    const nextToken = await tokenManager.getNextAvailableToken();
    if (nextToken && nextToken !== currentToken) {
      currentToken = nextToken;
      prSearchResponse = await fetch(
        `https://api.github.com/search/issues?q=repo:${owner}/${repo}+type:pr+${issueNumber}&per_page=10`,
        {
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${currentToken}`,
          },
        }
      );
      tokenManager.updateRateLimitFromResponse(prSearchResponse, currentToken);
      
      // If still rate limited, wait
      if (prSearchResponse.status === 403 || prSearchResponse.status === 429) {
        const retryAfter = prSearchResponse.headers.get('Retry-After');
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : (isSearchLimit ? 60000 : 300000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        prSearchResponse = await fetch(
          `https://api.github.com/search/issues?q=repo:${owner}/${repo}+type:pr+${issueNumber}&per_page=10`,
          {
            headers: {
              Accept: "application/vnd.github.v3+json",
              Authorization: `Bearer ${currentToken}`,
            },
          }
        );
        tokenManager.updateRateLimitFromResponse(prSearchResponse, currentToken);
      }
    } else {
      // No other token - wait
      const retryAfter = prSearchResponse.headers.get('Retry-After');
      const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : (isSearchLimit ? 60000 : 300000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      
      prSearchResponse = await fetch(
        `https://api.github.com/search/issues?q=repo:${owner}/${repo}+type:pr+${issueNumber}&per_page=10`,
        {
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${currentToken}`,
          },
        }
      );
      tokenManager.updateRateLimitFromResponse(prSearchResponse, currentToken);
    }
  }
  
  const linkedPRs: LinkedPR[] = [];
  if (prSearchResponse.ok) {
    const prSearch = await prSearchResponse.json() as { items: GitHubPRSearchItem[] };
    const issueRefPattern = /(?:closes?|fixes?|resolves?)\s*#(\d+)/gi;
    
    for (const item of prSearch.items) {
      // Verify it actually references this issue
      const text = `${item.title}`;
      const matches = [...text.matchAll(issueRefPattern)];
      const references = matches.some(m => parseInt(m[1]) === issueNumber);
      
      if (references || text.includes(`#${issueNumber}`)) {
        linkedPRs.push({
          number: item.number,
          title: item.title,
          state: item.state,
          merged: item.pull_request?.merged_at !== null,
          url: item.html_url,
        });
      }
    }
  }
  
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map(l => l.name),
    state: issue.state,
    author: issue.user.login,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    url: issue.html_url,
    comments,
    reactions: issue.reactions ? {
      total: issue.reactions.total_count,
      thumbsUp: issue.reactions["+1"],
      thumbsDown: issue.reactions["-1"],
      heart: issue.reactions.heart,
      confused: issue.reactions.confused,
    } : null,
    assignees: issue.assignees?.map(a => a.login) || [],
    milestone: issue.milestone?.title || null,
    linkedPRs,
  };
}

// ============================================================================
// Triage Logic
// ============================================================================

/**
 * Triage the issue to determine its type
 */
function triageIssue(context: IssueContext): TriageOutput {
  let bugScore = 0.5; // Start neutral
  const factors: TriageFactor[] = [];
  
  for (const factorDef of TRIAGE_FACTORS) {
    const result = factorDef.check(context);
    factors.push({
      factor: factorDef.factor,
      weight: factorDef.weight,
      matched: result.matched,
      detail: result.detail,
    });
    
    if (result.matched) {
      bugScore += factorDef.weight;
    }
  }
  
  // Clamp score between 0 and 1
  bugScore = Math.max(0, Math.min(1, bugScore));
  
  // Determine result based on score
  let result: TriageResult;
  let reasoning: string;
  
  if (bugScore >= 0.70) {
    result = "bug";
    reasoning = "High confidence bug: Issue has multiple bug indicators including error descriptions, reproduction steps, or bug labels.";
  } else if (bugScore >= 0.50) {
    result = "bug";
    reasoning = "Moderate confidence bug: Issue shows some bug characteristics but may need clarification.";
  } else if (bugScore >= 0.35) {
    result = "unclear";
    reasoning = "Unclear issue type: Could be a bug or configuration issue. May need more information.";
  } else if (bugScore >= 0.20) {
    result = "config";
    reasoning = "Likely configuration issue: Issue appears to be about setup, configuration, or usage questions.";
  } else if (bugScore >= 0.10) {
    result = "question";
    reasoning = "General question: User appears to be asking for help or clarification.";
  } else {
    result = "feature";
    reasoning = "Feature request: Issue appears to be requesting new functionality.";
  }
  
  // Add matched factors to reasoning
  const matchedBugFactors = factors.filter(f => f.matched && f.weight > 0);
  const matchedNonBugFactors = factors.filter(f => f.matched && f.weight < 0);
  
  if (matchedBugFactors.length > 0) {
    reasoning += ` Bug indicators: ${matchedBugFactors.map(f => f.factor).join(", ")}.`;
  }
  if (matchedNonBugFactors.length > 0) {
    reasoning += ` Non-bug indicators: ${matchedNonBugFactors.map(f => f.factor).join(", ")}.`;
  }
  
  return {
    result,
    confidence: bugScore,
    reasoning,
    factors,
  };
}

// ============================================================================
// Similarity Search
// ============================================================================

/**
 * Find similar historical fixes
 */
async function findSimilarFixes(
  prisma: PrismaClient,
  context: IssueContext,
  maxResults: number = 5
): Promise<SimilarFix[]> {
  // Create query text from issue
  const queryText = `${context.title} ${context.body || ""} ${context.labels.join(" ")}`;
  const queryEmbedding = createSimpleEmbedding(queryText);
  
  // Fetch all learnings (in production, use vector DB)
  const learnings = await prisma.pRLearning.findMany({
    where: {
      issueType: "bug", // Only look at bug fixes
    },
    orderBy: {
      prMergedAt: "desc",
    },
    take: 100, // Limit for performance
  });
  
  if (learnings.length === 0) {
    return [];
  }
  
  // Calculate similarities
  const similarities: Array<{
    learning: typeof learnings[0];
    similarity: number;
  }> = [];
  
  for (const learning of learnings) {
    // Create embedding from learning content
    const learningText = `${learning.issueTitle} ${learning.issueBody || ""} ${learning.issueLabels.join(" ")}`;
    const learningEmbedding = createSimpleEmbedding(learningText);
    
    const similarity = cosineSimilarity(queryEmbedding, learningEmbedding);
    similarities.push({ learning, similarity });
  }
  
  // Sort by similarity and take top results
  similarities.sort((a, b) => b.similarity - a.similarity);
  const topSimilar = similarities.slice(0, maxResults);
  
  // Convert to output format
  return topSimilar.map(({ learning, similarity }) => ({
    issueNumber: learning.issueNumber,
    issueTitle: learning.issueTitle,
    prNumber: learning.prNumber,
    prTitle: learning.prTitle,
    prUrl: `https://github.com/${learning.issueRepo}/pull/${learning.prNumber}`,
    prDiff: truncateDiff(learning.prDiff),
    prFilesChanged: learning.prFilesChanged,
    issueType: learning.issueType,
    subsystem: learning.subsystem,
    fixPatterns: learning.fixPatterns,
    similarity,
  }));
}

// ============================================================================
// Main Investigation Function
// ============================================================================

/**
 * Investigate a GitHub issue
 */
export async function investigateIssue(options: InvestigateOptions): Promise<InvestigationResult> {
  const { issueNumber, repo, includeDiscord = true, maxSimilarFixes = 5 } = options;
  
  const config = getConfig();
  const prisma = new PrismaClient();
  
  // Determine repo
  let owner: string;
  let repoName: string;
  
  if (repo) {
    const parts = repo.split("/");
    if (parts.length !== 2) {
      throw new Error(`Invalid repo format: ${repo}. Expected owner/repo`);
    }
    owner = parts[0];
    repoName = parts[1];
  } else {
    owner = config.github.owner;
    repoName = config.github.repo;
  }
  
  const issueRepo = `${owner}/${repoName}`;
  
  try {
    log(`[Investigate] Investigating issue #${issueNumber} in ${issueRepo}...`);
    
    // Check if already investigated
    const existingAttempt = await prisma.fixAttempt.findUnique({
      where: {
        issueNumber_issueRepo: {
          issueNumber,
          issueRepo,
        },
      },
    });
    
    const alreadyInvestigated = existingAttempt !== null;
    if (alreadyInvestigated) {
      log(`[Investigate] Issue #${issueNumber} was already investigated`);
    }
    
    // Initialize token manager
    const tokenManager = await GitHubTokenManager.fromEnvironment();
    if (!tokenManager) {
      throw new Error("GitHub token is required. Set GITHUB_TOKEN environment variable.");
    }
    
    // Fetch issue context
    log(`[Investigate] Fetching issue context...`);
    const issueContext = await fetchIssueContext(tokenManager, owner, repoName, issueNumber);
    
    // Include Discord threads if requested
    if (includeDiscord) {
      try {
        const threadMatches = await prisma.issueThreadMatch.findMany({
          where: { issueNumber },
          orderBy: { similarityScore: "desc" },
          take: 5,
        });
        
        issueContext.discordThreads = threadMatches.map(t => ({
          threadId: t.threadId,
          threadName: t.threadName || "",
          url: t.threadUrl || undefined,
          messageCount: t.messageCount,
          similarity: Number(t.similarityScore),
        }));
      } catch {
        // Discord data not available, continue
      }
    }
    
    // Triage the issue
    log(`[Investigate] Triaging issue...`);
    const triage = triageIssue(issueContext);
    log(`[Investigate] Triage result: ${triage.result} (confidence: ${(triage.confidence * 100).toFixed(1)}%)`);
    
    // Find similar fixes
    log(`[Investigate] Finding similar historical fixes...`);
    const similarFixes = await findSimilarFixes(prisma, issueContext, maxSimilarFixes);
    log(`[Investigate] Found ${similarFixes.length} similar fixes`);
    
    // Generate recommendation
    let recommendation: string;
    let shouldAttemptFix: boolean;
    
    if (issueContext.state === "closed") {
      recommendation = "Issue is already closed. No fix needed.";
      shouldAttemptFix = false;
    } else if (issueContext.linkedPRs.some(pr => pr.state === "open")) {
      recommendation = `Issue has an open PR (#${issueContext.linkedPRs.find(pr => pr.state === "open")?.number}). Wait for PR resolution.`;
      shouldAttemptFix = false;
    } else if (issueContext.assignees.length > 0) {
      recommendation = `Issue is assigned to: ${issueContext.assignees.join(", ")}. Avoid duplicate work.`;
      shouldAttemptFix = false;
    } else if (triage.result === "bug" && triage.confidence >= 0.50) {
      if (similarFixes.length > 0) {
        recommendation = `Bug with similar historical fixes found. Recommend attempting fix based on patterns from: ${similarFixes.slice(0, 2).map(f => `PR #${f.prNumber}`).join(", ")}.`;
      } else {
        recommendation = "Bug identified but no similar fixes found. Proceed with caution.";
      }
      shouldAttemptFix = true;
    } else if (triage.result === "config" || triage.result === "question") {
      recommendation = "Issue appears to be a configuration problem or question. Consider adding a helpful comment instead of code changes.";
      shouldAttemptFix = false;
    } else if (triage.result === "feature") {
      recommendation = "Issue appears to be a feature request. Not suitable for automated fix.";
      shouldAttemptFix = false;
    } else {
      recommendation = "Issue type is unclear. Manual review recommended before attempting fix.";
      shouldAttemptFix = false;
    }
    
    log(`[Investigate] Recommendation: ${recommendation}`);
    log(`[Investigate] Should attempt fix: ${shouldAttemptFix}`);
    
    return {
      issueContext,
      triage,
      similarFixes,
      recommendation,
      shouldAttemptFix,
      alreadyInvestigated,
    };
    
  } finally {
    await prisma.$disconnect();
  }
}
