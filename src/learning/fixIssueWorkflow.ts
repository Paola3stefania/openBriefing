/**
 * Fix Issue Workflow
 * 
 * Orchestrates the full issue fix workflow:
 * 1. Investigate the issue (gather context, triage, find similar fixes)
 * 2. If fix is provided, validate and open PR
 * 3. Track the entire attempt in the database
 * 
 * Can be called in two modes:
 * - Investigation only: Returns context for AI to generate fix
 * - Full fix: Takes generated fix and opens PR
 */

import { PrismaClient } from "@prisma/client";
import { getConfig } from "../config/index.js";
import { log, logError } from "../mcp/logger.js";
import { investigateIssue, InvestigationResult, IssueContext, TriageOutput, SimilarFix } from "./investigateIssue.js";
import { openPRWithFix, recordNoFix, FileChange, OpenPRResult, discoverProjectRules, ProjectRules } from "./openPRWithFix.js";
import { existsSync } from "fs";

// ============================================================================
// Types
// ============================================================================

export interface WorkflowOptions {
  issueNumber: number;
  repo?: string;                  // Override repo (default: from config)
  linearIssueId?: string;         // Optional Linear issue to update
  
  // Fix details (optional - if not provided, returns investigation only)
  fix?: {
    fileChanges: FileChange[];
    commitMessage: string;
    prTitle: string;
    prBody: string;
  };
  
  // Options
  skipInvestigation?: boolean;     // Skip investigation if already done
  forceAttempt?: boolean;          // Attempt fix even if not recommended
}

export interface WorkflowResult {
  // Status
  phase: "investigation" | "fix_created" | "no_fix" | "error";
  success: boolean;
  
  // Investigation results
  investigation?: {
    issueContext: IssueContext;
    triage: TriageOutput;
    similarFixes: SimilarFix[];
    recommendation: string;
    shouldAttemptFix: boolean;
  };
  
  // Project rules (for fix generation)
  projectRules?: ProjectRules;
  
  // Fix generation guidance
  fixGuidance?: {
    basedOnSimilarFixes: string[];
    suggestedPatterns: string[];
    subsystem: string | null;
    maxFilesAllowed: number;
    maxLinesAllowed: number;
  };
  
  // PR results (if fix was provided)
  pr?: {
    number: number;
    url: string;
    branchName: string;
    filesChanged: string[];
  };
  
  // Error information
  error?: string;
  noFixReason?: string;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_FILES_ALLOWED = 15;
const MAX_LINES_ALLOWED = 1000;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Detect subsystem from issue context
 */
function detectSubsystem(context: IssueContext): string | null {
  const text = `${context.title} ${context.body || ""} ${context.labels.join(" ")}`.toLowerCase();
  
  const subsystems: Record<string, string[]> = {
    "oauth": ["oauth", "provider", "google", "github", "apple", "discord", "twitter", "facebook"],
    "sso": ["sso", "saml", "oidc", "enterprise"],
    "organization": ["organization", "org", "team", "workspace", "multi-tenant"],
    "api-key": ["api-key", "api key", "bearer", "token auth"],
    "passkey": ["passkey", "webauthn", "passwordless"],
    "two-factor": ["2fa", "two-factor", "totp", "mfa", "otp"],
    "admin": ["admin", "dashboard", "management"],
    "session": ["session", "cookie", "jwt"],
    "adapter": ["adapter", "database", "prisma", "drizzle", "mongodb", "postgres"],
    "client": ["client", "react", "vue", "svelte", "next", "nuxt"],
  };
  
  for (const [subsystem, keywords] of Object.entries(subsystems)) {
    if (keywords.some(kw => text.includes(kw))) {
      return subsystem;
    }
  }
  
  return null;
}

/**
 * Extract suggested patterns from similar fixes
 */
function extractPatterns(similarFixes: SimilarFix[]): string[] {
  const patternCounts = new Map<string, number>();
  
  for (const fix of similarFixes) {
    for (const pattern of fix.fixPatterns) {
      patternCounts.set(pattern, (patternCounts.get(pattern) || 0) + 1);
    }
  }
  
  // Sort by frequency
  const sorted = [...patternCounts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 5).map(([pattern]) => pattern);
}

// ============================================================================
// Main Workflow
// ============================================================================

/**
 * Execute the fix issue workflow
 */
export async function fixIssueWorkflow(options: WorkflowOptions): Promise<WorkflowResult> {
  const { issueNumber, repo, linearIssueId, fix, skipInvestigation, forceAttempt } = options;
  
  const config = getConfig();
  const prisma = new PrismaClient();
  
  // Determine repo
  let owner: string;
  let repoName: string;
  
  if (repo) {
    const parts = repo.split("/");
    if (parts.length !== 2) {
      return { phase: "error", success: false, error: `Invalid repo format: ${repo}` };
    }
    owner = parts[0];
    repoName = parts[1];
  } else {
    owner = config.github.owner;
    repoName = config.github.repo;
  }
  
  const fullRepo = `${owner}/${repoName}`;
  
  try {
    log(`[Workflow] Starting fix workflow for issue #${issueNumber} in ${fullRepo}...`);
    
    // ========================================================================
    // Phase 1: Investigation
    // ========================================================================
    
    let investigation: InvestigationResult | null = null;
    
    if (!skipInvestigation) {
      log(`[Workflow] Phase 1: Investigating issue...`);
      investigation = await investigateIssue({
        issueNumber,
        repo,
        includeDiscord: true,
        maxSimilarFixes: 5,
      });
      
      log(`[Workflow] Triage: ${investigation.triage.result} (${(investigation.triage.confidence * 100).toFixed(1)}%)`);
      log(`[Workflow] Similar fixes found: ${investigation.similarFixes.length}`);
      log(`[Workflow] Should attempt fix: ${investigation.shouldAttemptFix}`);
    }
    
    // ========================================================================
    // Get Project Rules
    // ========================================================================
    
    let projectRules: ProjectRules | undefined;
    const localRepoPath = process.env.LOCAL_REPO_PATH;
    
    if (localRepoPath && existsSync(localRepoPath)) {
      projectRules = discoverProjectRules(localRepoPath);
    }
    
    // ========================================================================
    // Phase 2: Determine if we should proceed
    // ========================================================================
    
    // If no fix provided, return investigation results for AI to generate fix
    if (!fix) {
      log(`[Workflow] No fix provided - returning investigation results for fix generation`);
      
      if (!investigation) {
        return { phase: "error", success: false, error: "Investigation required when fix not provided" };
      }
      
      // Prepare fix guidance
      const subsystem = detectSubsystem(investigation.issueContext);
      const suggestedPatterns = extractPatterns(investigation.similarFixes);
      
      return {
        phase: "investigation",
        success: true,
        investigation: {
          issueContext: investigation.issueContext,
          triage: investigation.triage,
          similarFixes: investigation.similarFixes,
          recommendation: investigation.recommendation,
          shouldAttemptFix: investigation.shouldAttemptFix,
        },
        projectRules,
        fixGuidance: {
          basedOnSimilarFixes: investigation.similarFixes.slice(0, 3).map(f => 
            `PR #${f.prNumber}: ${f.prTitle} (files: ${f.prFilesChanged.join(", ")})`
          ),
          suggestedPatterns,
          subsystem,
          maxFilesAllowed: MAX_FILES_ALLOWED,
          maxLinesAllowed: MAX_LINES_ALLOWED,
        },
      };
    }
    
    // ========================================================================
    // Phase 3: Validate fix attempt
    // ========================================================================
    
    log(`[Workflow] Phase 3: Validating fix attempt...`);
    
    // Check if we should attempt the fix
    const shouldAttempt = forceAttempt || (investigation?.shouldAttemptFix ?? true);
    
    if (!shouldAttempt && investigation) {
      log(`[Workflow] Fix not recommended: ${investigation.recommendation}`);
      
      // Record the no-fix decision
      await recordNoFix(
        issueNumber,
        investigation.issueContext.title,
        fullRepo,
        investigation.triage.result,
        investigation.triage.confidence,
        investigation.triage.reasoning,
        investigation.recommendation,
        linearIssueId
      );
      
      return {
        phase: "no_fix",
        success: true,
        investigation: investigation ? {
          issueContext: investigation.issueContext,
          triage: investigation.triage,
          similarFixes: investigation.similarFixes,
          recommendation: investigation.recommendation,
          shouldAttemptFix: investigation.shouldAttemptFix,
        } : undefined,
        noFixReason: investigation.recommendation,
      };
    }
    
    // ========================================================================
    // Phase 4: Open PR
    // ========================================================================
    
    log(`[Workflow] Phase 4: Opening PR with fix...`);
    
    const triageResult = investigation?.triage.result || "bug";
    const triageConfidence = investigation?.triage.confidence || 0.5;
    const triageReasoning = investigation?.triage.reasoning;
    const issueTitle = investigation?.issueContext.title || `Issue #${issueNumber}`;
    
    const prResult = await openPRWithFix({
      issueNumber,
      issueTitle,
      issueRepo: fullRepo,
      triageResult,
      triageConfidence,
      triageReasoning,
      fileChanges: fix.fileChanges,
      commitMessage: fix.commitMessage,
      prTitle: fix.prTitle,
      prBody: fix.prBody,
      linearIssueId,
    });
    
    if (!prResult.success) {
      log(`[Workflow] PR creation failed: ${prResult.error}`);
      
      return {
        phase: "error",
        success: false,
        investigation: investigation ? {
          issueContext: investigation.issueContext,
          triage: investigation.triage,
          similarFixes: investigation.similarFixes,
          recommendation: investigation.recommendation,
          shouldAttemptFix: investigation.shouldAttemptFix,
        } : undefined,
        error: prResult.error,
      };
    }
    
    log(`[Workflow] PR created successfully: ${prResult.prUrl}`);
    
    return {
      phase: "fix_created",
      success: true,
      investigation: investigation ? {
        issueContext: investigation.issueContext,
        triage: investigation.triage,
        similarFixes: investigation.similarFixes,
        recommendation: investigation.recommendation,
        shouldAttemptFix: investigation.shouldAttemptFix,
      } : undefined,
      projectRules,
      pr: {
        number: prResult.prNumber!,
        url: prResult.prUrl!,
        branchName: prResult.branchName!,
        filesChanged: prResult.filesChanged!,
      },
    };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logError("[Workflow] Failed:", error);
    
    return {
      phase: "error",
      success: false,
      error: errorMsg,
    };
    
  } finally {
    await prisma.$disconnect();
  }
}
