# Open PR With Fix Tool - Design Document

> **Status:** Planning  
> **Last Updated:** January 2026

## Overview

A two-tool MCP system that investigates GitHub issues, learns from past fixes, and opens draft PRs with AI-generated solutions. Uses Claude Opus 4.5 (thinking mode) via Cursor for intelligent fix generation.

## Goals

1. **Automate bug investigation** - Gather full context from GitHub issues, comments, and linked Discord threads
2. **Smart triage** - Distinguish between real bugs and configuration/user errors
3. **Learn from history** - Use embeddings of closed issues + their PRs to improve fix quality
4. **Generate fixes** - Use AI to analyze multiple approaches and pick the best solution
5. **Open PRs** - Create properly formatted draft PRs following project conventions
6. **Track progress** - Store results in DB to avoid re-processing and measure success

## Architecture: Two Tools

The system is split into two MCP tools that work together:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  TOOL 1: investigate_issue                                                   │
│  Purpose: Gather context, triage, find learnings from similar issues         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. CHECK DB → Already investigated? Return cached result (unless force)     │
│                                                                              │
│  2. GATHER CONTEXT                                                           │
│     ├─→ GitHub issue (title, body, comments)                                │
│     ├─→ Linked Discord threads                                              │
│     ├─→ Related code files (FULL content via embeddings)                    │
│     └─→ Code ownership info                                                 │
│                                                                              │
│  3. FIND SIMILAR CLOSED ISSUES                                               │
│     ├─→ Search PRLearning table by embedding similarity                     │
│     ├─→ Return: similar issues + their PR diffs + reviewer feedback         │
│     └─→ Extract patterns that worked before                                 │
│                                                                              │
│  4. TRIAGE                                                                   │
│     └─→ Classify: bug | config_problem | feature_request | unclear          │
│                                                                              │
│  5. LOAD PROJECT RULES                                                       │
│     └─→ {LOCAL_REPO_PATH}/.cursor/rules                                     │
│                                                                              │
│  6. RETURN: Full investigation context for AI to process                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │  CLAUDE OPUS 4.5 (in Cursor)  │
                    │  Analyzes context, generates  │
                    │  fix using thinking mode      │
                    └───────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  TOOL 2: open_pr_with_fix                                                    │
│  Purpose: Create branch, commit changes, open draft PR                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. VALIDATE                                                                 │
│     ├─→ Check learnings match the proposed fix approach                     │
│     ├─→ Check limits if set (max_files, max_lines)                          │
│     └─→ Validate against project rules                                      │
│                                                                              │
│  2. GIT OPERATIONS                                                           │
│     ├─→ Stash any uncommitted changes not ours                              │
│     ├─→ git fetch origin && git checkout canary && git pull                 │
│     ├─→ git checkout -b type/subsystem-description                          │
│     │   (if branch exists, add -paola3stefania suffix)                      │
│     ├─→ Apply code changes                                                  │
│     ├─→ git add -A && git commit -m "type(scope): description"              │
│     └─→ git push -u origin branch-name                                      │
│                                                                              │
│  3. CREATE PR via GitHub API                                                 │
│     ├─→ Draft PR with proper title/body format                              │
│     └─→ Link to issue with "Fixes #123"                                     │
│                                                                              │
│  4. UPDATE LINEAR                                                            │
│     ├─→ Add PR link to ticket                                               │
│     └─→ Set status to "In Progress"                                         │
│                                                                              │
│  5. SAVE TO DB                                                               │
│     └─→ Track attempt in FixAttempt table                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## AI Model

| Aspect | Decision |
|--------|----------|
| Model | Claude Opus 4.5 (thinking mode) |
| Invocation | Via Cursor (user calls MCP tools, AI processes results) |
| Code Context | Full file contents (not snippets) |
| Fix Strategy | Analyze multiple approaches, pick best that fits repo patterns |

## Limits

| Limit | Default | Notes |
|-------|---------|-------|
| Max files changed | No limit | Can be set via `max_files` parameter |
| Max lines changed | No limit | Can be set via `max_lines` parameter |
| Excluded paths | None | All files are fair game |

Limits are **optional** - only enforced if explicitly passed to `open_pr_with_fix`.

## Configuration

### Required Environment Variables

All configuration uses existing environment variables:

| Variable | Purpose | Example |
|----------|---------|---------|
| `LOCAL_REPO_PATH` | Local clone of the repo to fix | `/Users/user/Coding/betterAuth/better-auth` |
| `GITHUB_REPO_URL` | GitHub repo (owner/repo format) | `better-auth/better-auth` |
| `GITHUB_TOKEN` | Token with `repo` scope | `ghp_xxx...` |
| `OPENAI_API_KEY` | For embeddings | `sk-xxx...` |
| `DATABASE_URL` | PostgreSQL for tracking attempts | `postgresql://...` |
| `PM_TOOL_API_KEY` | Linear API key for ticket updates | `lin_api_xxx...` |

### GitHub Token Permissions

The `GITHUB_TOKEN` needs these scopes:
- `repo` - Full control of private repositories (for creating branches, pushing, opening PRs)

Or if using GitHub App:
- `contents: write` - Push commits
- `pull_requests: write` - Create PRs

## Git Workflow

### Command Sequence

```bash
cd {LOCAL_REPO_PATH}

# 1. Handle uncommitted changes
git stash push -m "auto-stash-before-fix"  # Stash anything not ours

# 2. Update from remote
git fetch origin
git checkout canary
git pull origin canary

# 3. Create feature branch
BRANCH_NAME="fix/subsystem-description"
if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  BRANCH_NAME="${BRANCH_NAME}-paola3stefania"  # Add suffix if exists
fi
git checkout -b "$BRANCH_NAME"

# 4. Apply changes (done by the tool)
# ... modify files ...

# 5. Commit and push
git add -A
git commit -m "fix(subsystem): description"
git push -u origin "$BRANCH_NAME"

# 6. Create PR via GitHub API (draft mode)
```

### Edge Cases

| Scenario | Action |
|----------|--------|
| Branch already exists | Add `-paola3stefania` suffix |
| Uncommitted changes | Stash them before starting |
| Merge conflicts | Abort and report error |
| Push fails | Report error, don't create PR |

## Project Rules Discovery

The tool automatically discovers project conventions from the local repo:

```
Search order:
1. {LOCAL_REPO_PATH}/.cursor/rules.mdc
2. {LOCAL_REPO_PATH}/.cursor/rules
3. {LOCAL_REPO_PATH}/.cursorrules
4. {LOCAL_REPO_PATH}/CONTRIBUTING.md
```

### Parsed Rules Structure

```typescript
interface ProjectRules {
  // Branch naming
  branchFormat: string;           // e.g., "type/subsystem-description"
  
  // PR format
  prTitleFormat: string;          // e.g., "type(subsystem): description"
  baseBranch: string;             // e.g., "canary"
  
  // Commit format
  commitFormat: string;           // e.g., "type(scope): description"
  
  // Valid types and subsystems
  types: string[];                // ["fix", "feat", "chore", ...]
  subsystems: string[];           // ["oauth", "sso", "organization", ...]
  
  // Description rules
  descriptionRules: {
    lowercase: boolean;
    presentTense: boolean;
    maxLength: number;
    noPeriod: boolean;
  };
  
  // Code style (for generating fixes)
  codeStyle: {
    noInlineComments: boolean;
    noAnyUnknown: boolean;
    useInternalUtilities: boolean;
    // ... other rules
  };
}
```

### Better Auth Rules (Current)

From `/Users/user/Coding/betterAuth/better-auth/.cursor/rules`:

| Rule | Value |
|------|-------|
| Branch Format | `type/subsystem-description` |
| PR Title Format | `type(subsystem): description` |
| Base Branch | `canary` |
| Types | `fix`, `feat`, `chore`, `refactor`, `doc`, `test`, `deps`, `build` |
| Subsystems | `sso`, `saml`, `organization`, `api-key`, `passkey`, `two-factor`, `admin`, `stripe`, `oauth`, `adapter`, `cli`, `client`, `db`, `tools` |
| Description | Lowercase, present tense, <50 chars, no period |
| Code Style | No inline comments, no `any`/`unknown`, use internal utilities |

## Confidence Threshold (Triage)

The tool uses a confidence scoring system to determine if an issue is a real bug vs. a configuration problem:

### Scoring Factors

```typescript
const confidenceFactors = {
  // Positive indicators (likely a real bug)
  hasReproductionSteps: +0.20,        // Issue has clear steps to reproduce
  hasErrorMessage: +0.15,             // Specific error message to search for
  hasCodeReference: +0.15,            // Points to specific file/function
  multipleUsersReporting: +0.10,      // Not just one person's issue
  recentCodeChange: +0.10,            // Related code changed recently
  hasFailingTest: +0.20,              // Test case exists or can be written
  maintainerConfirmed: +0.25,         // Maintainer acknowledged as bug
  
  // Negative indicators (likely config/user error)
  mentionsEnvVars: -0.20,             // Mentions environment variables
  mentionsWorksForMe: -0.25,          // Someone else got it working
  mentionsSetup: -0.15,               // Setup/installation related
  noReproSteps: -0.20,                // Can't reproduce
  onlyOneUser: -0.10,                 // Single report, no confirmations
  labeledQuestion: -0.30,             // Labeled as "question" or "support"
};
```

### Thresholds

| Confidence | Action |
|------------|--------|
| >= 0.70 | Auto-attempt fix |
| 0.40 - 0.69 | Attempt fix but flag as uncertain |
| < 0.40 | Skip, update Linear with triage result |

### Triage Output

```typescript
interface TriageResult {
  type: 'bug' | 'config_problem' | 'feature_request' | 'question' | 'unclear';
  confidence: number;           // 0.0 - 1.0
  reasoning: string;            // Human-readable explanation
  suggestedAction: 'fix' | 'respond' | 'close' | 'needs_info';
  relatedCode?: string[];       // Files that might be relevant
}
```

## Learning System

The tool learns from closed issues and their PRs to improve fix quality over time.

### What We Learn From

1. **Closed issues** - The problem description, comments, and resolution
2. **PR diffs** - The actual code changes that fixed the issue
3. **Reviewer feedback** - Comments on the PR (what was good, what needed changes)
4. **Fix patterns** - Common approaches (null checks, error handling, type fixes, etc.)

### How Learning Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Learning Pipeline                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. When an issue is closed with a merged PR:                               │
│     ├─→ Fetch the PR diff                                                   │
│     ├─→ Fetch PR review comments                                            │
│     ├─→ Create embedding of (issue + PR diff + comments)                    │
│     └─→ Store in PRLearning table                                           │
│                                                                              │
│  2. When investigating a new issue:                                          │
│     ├─→ Create embedding of the new issue                                   │
│     ├─→ Find similar closed issues via embedding similarity                 │
│     ├─→ Return their PR diffs as examples                                   │
│     └─→ AI uses these as reference for generating fix                       │
│                                                                              │
│  3. Feedback loop:                                                           │
│     ├─→ If our PR gets merged → success signal                              │
│     ├─→ If our PR gets rejected/changed → learn from feedback               │
│     └─→ Update patterns based on outcomes                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Learning Query Example

When investigating issue #1234 about "OAuth refresh token":

```typescript
// Find similar closed issues
const similar = await db.prLearning.findMany({
  where: { 
    issueState: 'closed',
    embedding: { similarity: issueEmbedding, threshold: 0.7 }
  },
  orderBy: { similarity: 'desc' },
  take: 5
});

// Returns:
// - Issue #890: "OAuth token expiration" → PR #891 (added try/catch)
// - Issue #456: "Refresh flow failing" → PR #457 (fixed null check)
// - Issue #234: "Token not refreshing" → PR #235 (added retry logic)
```

## Database Schema

### FixAttempt - Track fix attempts

```prisma
model FixAttempt {
  id                String   @id @default(uuid())
  
  // Issue identification
  issueNumber       Int      @map("issue_number")
  issueRepo         String   @map("issue_repo")        // e.g., "better-auth/better-auth"
  issueTitle        String   @map("issue_title")
  
  // Triage results
  triageResult      String   @map("triage_result")     // 'bug' | 'config' | 'feature' | 'question' | 'unclear'
  triageConfidence  Decimal  @db.Decimal(3, 2)         // 0.00 - 1.00
  triageReasoning   String?  @map("triage_reasoning")  @db.Text
  
  // Fix attempt
  fixAttempted      Boolean  @default(false) @map("fix_attempted")
  fixSucceeded      Boolean? @map("fix_succeeded")
  
  // PR details (if created)
  prNumber          Int?     @map("pr_number")
  prUrl             String?  @map("pr_url")
  prTitle           String?  @map("pr_title")
  branchName        String?  @map("branch_name")
  filesChanged      String[] @default([]) @map("files_changed")
  
  // If no fix was created
  noFixReason       String?  @map("no_fix_reason")     // 'config_issue' | 'unclear_repro' | 'too_complex' | 'already_fixed'
  
  // Linear integration
  linearIssueId     String?  @map("linear_issue_id")
  linearCommentId   String?  @map("linear_comment_id") // Comment added about result
  linearUpdated     Boolean  @default(false) @map("linear_updated")
  
  // Timestamps
  attemptedAt       DateTime @default(now()) @map("attempted_at")
  createdAt         DateTime @default(now()) @map("created_at")
  updatedAt         DateTime @updatedAt @map("updated_at")
  
  @@unique([issueNumber, issueRepo])
  @@index([triageResult])
  @@index([fixSucceeded])
  @@index([attemptedAt(sort: Desc)])
  @@index([issueRepo])
  @@map("fix_attempts")
}
```

### PRLearning - Learn from past fixes

```prisma
model PRLearning {
  id                String   @id @default(uuid())
  
  // Issue info
  issueNumber       Int      @map("issue_number")
  issueRepo         String   @map("issue_repo")
  issueTitle        String   @map("issue_title")
  issueBody         String?  @map("issue_body") @db.Text
  issueLabels       String[] @map("issue_labels")
  issueState        String   @map("issue_state")       // 'closed'
  
  // PR info
  prNumber          Int      @map("pr_number")
  prTitle           String   @map("pr_title")
  prBody            String?  @map("pr_body") @db.Text
  prDiff            String   @map("pr_diff") @db.Text  // The actual diff
  prFilesChanged    String[] @map("pr_files_changed")
  prLinesAdded      Int      @map("pr_lines_added")
  prLinesRemoved    Int      @map("pr_lines_removed")
  prMergedAt        DateTime? @map("pr_merged_at")
  prAuthor          String   @map("pr_author")
  
  // Classification
  issueType         String   @map("issue_type")        // 'bug' | 'feature' | 'docs' | etc.
  subsystem         String?                            // 'oauth' | 'sso' | etc.
  fixPatterns       String[] @map("fix_patterns")      // ['null_check', 'error_handling', 'type_fix']
  
  // Reviewer feedback
  reviewComments    Json     @default("[]") @map("review_comments")  // Array of review comments
  reviewOutcome     String?  @map("review_outcome")    // 'approved' | 'changes_requested' | 'merged_without_review'
  
  // Embedding for similarity search
  embedding         Json     @map("embedding")         // Vector embedding of issue+PR
  contentHash       String   @map("content_hash")      // For deduplication
  
  // Timestamps
  learnedAt         DateTime @default(now()) @map("learned_at")
  createdAt         DateTime @default(now()) @map("created_at")
  updatedAt         DateTime @updatedAt @map("updated_at")
  
  @@unique([issueNumber, prNumber, issueRepo])
  @@index([issueRepo])
  @@index([issueType])
  @@index([subsystem])
  @@index([fixPatterns], type: Gin)
  @@index([prMergedAt(sort: Desc)])
  @@map("pr_learnings")
}
```

## MCP Tool Definitions

### Tool 1: investigate_issue

```typescript
{
  name: "investigate_issue",
  description: "Investigate a GitHub issue: gather full context, find similar closed issues with their PR fixes, triage, and return everything needed to generate a fix. Uses LOCAL_REPO_PATH for code and rules.",
  parameters: {
    issue_number: {
      type: "number",
      required: true,
      description: "GitHub issue number to investigate"
    },
    force: {
      type: "boolean",
      default: false,
      description: "Re-investigate even if this issue was previously processed"
    },
    include_similar: {
      type: "number",
      default: 5,
      description: "Number of similar closed issues to include as learning examples"
    }
  },
  returns: {
    issue: "Full issue with body, comments, labels",
    discordThreads: "Linked Discord discussions",
    relatedCode: "Full content of relevant files",
    codeOwnership: "Who owns the affected files",
    triage: "Classification result with confidence",
    projectRules: "Branch/PR/commit conventions",
    similarIssues: "Past closed issues with their PR diffs as examples",
    fixPatterns: "Common patterns from similar fixes"
  }
}
```

### Tool 2: open_pr_with_fix

```typescript
{
  name: "open_pr_with_fix",
  description: "Create a draft PR with the provided fix. Validates against learnings and project rules, handles git operations, and updates Linear.",
  parameters: {
    issue_number: {
      type: "number",
      required: true,
      description: "GitHub issue number this fix addresses"
    },
    fix_type: {
      type: "string",
      required: true,
      enum: ["fix", "feat", "chore", "refactor", "doc", "test"],
      description: "Type of change (determines branch/PR prefix)"
    },
    subsystem: {
      type: "string",
      required: false,
      description: "Subsystem affected (oauth, sso, organization, etc.)"
    },
    description: {
      type: "string",
      required: true,
      description: "Short description for branch/commit/PR (lowercase, present tense, <50 chars)"
    },
    files: {
      type: "array",
      required: true,
      description: "Array of {path, content} objects with the fixed file contents"
    },
    pr_body: {
      type: "string",
      required: true,
      description: "Full PR description in markdown"
    },
    dry_run: {
      type: "boolean",
      default: false,
      description: "Show what would happen without creating branch/PR"
    },
    max_files: {
      type: "number",
      required: false,
      description: "Optional: Maximum number of files allowed to change. No limit if not set."
    },
    max_lines: {
      type: "number",
      required: false,
      description: "Optional: Maximum number of lines allowed to change. No limit if not set."
    }
  },
  returns: {
    success: "boolean",
    branch: "Created branch name",
    prNumber: "PR number",
    prUrl: "URL to the draft PR",
    linearUpdated: "Whether Linear ticket was updated",
    errors: "Any errors encountered"
  }
}
```

### Tool 3: learn_from_pr (Background/Cron)

```typescript
{
  name: "learn_from_pr",
  description: "Learn from a merged PR: store the issue+PR+diff+feedback for future reference. Can be triggered manually or via webhook when PRs are merged.",
  parameters: {
    pr_number: {
      type: "number",
      required: true,
      description: "PR number to learn from"
    },
    force: {
      type: "boolean",
      default: false,
      description: "Re-learn even if already processed"
    }
  }
}
```

### Tool 4: seed_pr_learnings (One-time Setup)

```typescript
{
  name: "seed_pr_learnings",
  description: "One-time seeding: fetch all historical closed issues with merged PRs and populate the PRLearning table. This bootstraps the learning system with past fixes so investigate_issue has examples from day 1.",
  parameters: {
    since: {
      type: "string",
      required: false,
      description: "ISO date to fetch issues from (e.g., '2023-01-01'). Defaults to all time."
    },
    limit: {
      type: "number",
      required: false,
      description: "Max number of issues to process. Defaults to all."
    },
    dry_run: {
      type: "boolean",
      default: false,
      description: "Show what would be seeded without actually storing"
    },
    batch_size: {
      type: "number",
      default: 50,
      description: "Number of issues to process per batch (for rate limiting)"
    }
  },
  returns: {
    totalIssuesFound: "Number of closed issues found",
    issuesWithPRs: "Number of issues that had linked PRs",
    prLearningsCreated: "Number of PRLearning records created",
    errors: "Any issues that failed to process",
    timeElapsed: "Total time taken"
  }
}
```

#### Seeding Process

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         seed_pr_learnings Flow                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. FETCH CLOSED ISSUES                                                      │
│     GET /repos/better-auth/better-auth/issues?state=closed&per_page=100     │
│     └─→ Paginate through all closed issues                                  │
│                                                                              │
│  2. FOR EACH ISSUE, FIND LINKED PR                                          │
│     ├─→ Check issue body for "Fixes #X" / "Closes #X" references           │
│     ├─→ Check timeline events for PR merge events                           │
│     └─→ Check if issue was closed by a PR                                   │
│                                                                              │
│  3. FETCH PR DETAILS                                                         │
│     ├─→ GET /repos/.../pulls/{pr_number}                                    │
│     ├─→ GET /repos/.../pulls/{pr_number}/files (the diff)                   │
│     └─→ GET /repos/.../pulls/{pr_number}/reviews (feedback)                 │
│                                                                              │
│  4. CLASSIFY & EXTRACT PATTERNS                                              │
│     ├─→ Detect issue type from labels (bug, feature, etc.)                  │
│     ├─→ Detect subsystem from file paths (oauth, sso, etc.)                 │
│     └─→ Extract fix patterns from diff (null_check, error_handling, etc.)  │
│                                                                              │
│  5. CREATE EMBEDDING                                                         │
│     └─→ Embed: issue_title + issue_body + pr_title + pr_diff_summary        │
│                                                                              │
│  6. STORE IN PRLearning TABLE                                                │
│     └─→ Insert with all metadata for future similarity searches             │
│                                                                              │
│  Rate limiting: 50 issues per batch, 1 second delay between batches         │
│  Resume support: Skip issues already in PRLearning table                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Expected Results for Better Auth

| Metric | Estimate |
|--------|----------|
| Total closed issues | ~500-1000 |
| Issues with linked PRs | ~300-600 |
| PRLearning records created | ~300-600 |
| Time to seed | ~1-2 hours (rate limited) |
| Storage needed | ~50-100 MB (diffs + embeddings) |

## Linear Integration

### On Success (PR Created)

Update the Linear ticket with:
- Status: "In Progress"
- Add comment with PR link and summary

```markdown
## Automated Fix Attempted

A draft PR has been opened to address this issue:
- PR: [#123](https://github.com/better-auth/better-auth/pull/123)
- Branch: `fix/oauth-token-refresh`

### Changes
- `packages/better-auth/src/oauth/refresh.ts`

### Summary
[AI-generated explanation of the fix]

---
*This PR was auto-generated. Please review before merging.*
```

### On No Fix (Config Issue / Unclear)

Add comment explaining triage result:

```markdown
## Automated Triage Result

This issue was analyzed but a fix was not attempted.

**Classification:** Configuration Issue (confidence: 0.35)

**Reasoning:**
- Issue mentions environment variables
- Another user reported "works for me"
- No clear reproduction steps provided

**Suggested Action:** 
Request more information from the reporter about their setup.

---
*This triage was auto-generated. Override by adding the `confirmed-bug` label.*
```

## Example Output

### Input
```
issue_number: 1234
```

### Issue Context
```
Title: OAuth token refresh failing silently
Body: When using Google OAuth, the refresh token flow fails without any error...
Labels: [bug]
Comments: 3 (including reproduction steps)
Discord threads: 2 matched (similarity > 60%)
```

### Triage
```json
{
  "type": "bug",
  "confidence": 0.78,
  "reasoning": "Clear reproduction steps, error message provided, multiple users reporting, affects core OAuth flow",
  "suggestedAction": "fix",
  "relatedCode": [
    "packages/better-auth/src/oauth/refresh.ts",
    "packages/better-auth/src/oauth/providers/google.ts"
  ]
}
```

### Generated PR
```
Branch:   fix/oauth-token-refresh
Title:    fix(oauth): handle token refresh failure gracefully
Base:     canary
Draft:    true

Body:
  Fixes #1234
  
  ## Problem
  The OAuth token refresh flow was failing silently when the refresh token 
  was expired or revoked. Users were being logged out without explanation.
  
  ## Solution
  - Added explicit error handling in `refreshAccessToken()`
  - Return proper error response instead of silently failing
  - Added debug logging for refresh failures
  
  ## Changes
  - `packages/better-auth/src/oauth/refresh.ts`
  
  ## Testing
  - Added test case for expired refresh token scenario
  
  ---
  *This PR was auto-generated from issue #1234. Please review carefully.*
```

## Error Recovery

### Git Push Fails

```
┌─────────────────────────────────────────────────────────────────┐
│  Git Push Failure                                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Attempt push                                                 │
│     └─→ FAILS (network, auth, conflict, etc.)                   │
│                                                                  │
│  2. Retry up to 3 times with backoff                            │
│     └─→ Wait: 2s → 5s → 10s                                     │
│                                                                  │
│  3. If still failing:                                            │
│     ├─→ git reset --hard HEAD~1  (undo commit)                  │
│     ├─→ git checkout canary      (back to base)                 │
│     ├─→ git branch -D {branch}   (delete failed branch)         │
│     ├─→ git stash pop            (restore stashed changes)      │
│     └─→ Save error to FixAttempt with status: 'git_push_failed' │
│                                                                  │
│  4. Return error to user, suggest manual retry                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### GitHub API Rate Limited

```
┌─────────────────────────────────────────────────────────────────┐
│  GitHub API Rate Limited                                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Detect rate limit (403 with X-RateLimit-Remaining: 0)       │
│                                                                  │
│  2. Check X-RateLimit-Reset header for reset time               │
│                                                                  │
│  3. Options:                                                     │
│     ├─→ If reset < 5 min: Wait and auto-retry                   │
│     ├─→ If reset > 5 min: Save progress, return partial result  │
│     └─→ For seeding: Resume from last processed issue           │
│                                                                  │
│  4. Use exponential backoff for transient errors:               │
│     └─→ 1s → 2s → 4s → 8s → 16s (max 5 retries)                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Linear Update Fails

```
┌─────────────────────────────────────────────────────────────────┐
│  Linear Update Failure                                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. PR created successfully                                      │
│                                                                  │
│  2. Attempt Linear update                                        │
│     └─→ FAILS (API error, auth, rate limit)                     │
│                                                                  │
│  3. Retry up to 3 times with backoff                            │
│     └─→ Wait: 1s → 3s → 5s                                      │
│                                                                  │
│  4. If still failing:                                            │
│     ├─→ Log warning (don't fail the whole operation)            │
│     ├─→ Save to FixAttempt: linearUpdated = false               │
│     └─→ Queue for later retry                                   │
│                                                                  │
│  5. Background job retries failed Linear updates periodically   │
│     └─→ Every 15 min, retry any with linearUpdated = false      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Error Recovery Summary

| Failure | Retry? | Rollback? | Block Operation? |
|---------|--------|-----------|------------------|
| Git push | 3x with backoff | Yes, full cleanup | Yes |
| GitHub API rate limit | Wait + retry | No | Partial (can resume) |
| Linear update | 3x + background retry | No | No (PR still created) |
| Embedding API | 3x | No | No (skip that item) |

## Workflow Example

### Step 1: Investigate

```
User: "Investigate issue #1234"

AI calls: investigate_issue(issue_number: 1234)

Returns:
- Issue: "OAuth token refresh failing silently" 
- Related code: 3 files (full content)
- Similar issues: 2 past fixes with diffs
- Triage: { type: "bug", confidence: 0.78 }
- Rules: { branch: "fix/oauth-*", base: "canary" }
```

### Step 2: AI Generates Fix

AI (Opus 4.5 thinking mode):
1. Analyzes issue context
2. Reviews similar past fixes
3. Examines related code
4. Thinks through multiple approaches
5. Picks best solution that matches repo patterns
6. Generates fixed file contents

### Step 3: Open PR

```
AI calls: open_pr_with_fix(
  issue_number: 1234,
  fix_type: "fix",
  subsystem: "oauth",
  description: "handle token refresh failure gracefully",
  files: [{ path: "packages/better-auth/src/oauth/refresh.ts", content: "..." }],
  pr_body: "Fixes #1234\n\n## Problem\n..."
)

Returns:
- branch: "fix/oauth-handle-token-refresh-failure-gracefully"
- prNumber: 5678
- prUrl: "https://github.com/better-auth/better-auth/pull/5678"
- linearUpdated: true
```

## Build Order

The tools should be built in this order:

```
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: Learning Foundation                                    │
├─────────────────────────────────────────────────────────────────┤
│  1. seed_pr_learnings                                            │
│     └─→ Populate PRLearning table with historical data          │
│     └─→ ~300-600 past fixes ready for similarity search         │
│                                                                  │
│  2. learn_from_pr                                                │
│     └─→ Keep learning data fresh as new PRs merge               │
│     └─→ Can run manually or via future webhook                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 2: Investigation                                          │
├─────────────────────────────────────────────────────────────────┤
│  3. investigate_issue                                            │
│     └─→ Core investigation logic                                │
│     └─→ Returns full context for AI to generate fix             │
│     └─→ Includes similar past fixes from Phase 1                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 3: PR Creation                                            │
├─────────────────────────────────────────────────────────────────┤
│  4. open_pr_with_fix                                             │
│     └─→ Git operations + PR creation                            │
│     └─→ Linear integration                                      │
│     └─→ The final piece that ties everything together           │
└─────────────────────────────────────────────────────────────────┘
```

## Future Enhancements

1. **Multi-repo support** - Handle issues across Better Auth org repos (docs, infrastructure, etc.)
2. **Test generation** - Auto-generate test cases alongside the fix
3. **Webhook integration** - Auto-trigger `learn_from_pr` when PRs are merged
4. **Batch processing** - Process multiple issues in one run
5. **Confidence calibration** - Track actual outcomes to tune triage confidence scores
6. **Auto-retry on feedback** - If PR review requests changes, learn and retry
7. **Notifications** - Discord/Slack notifications when PRs are created (deferred)

## Related Documentation

- [GitHub Integration](./GITHUB_INTEGRATION.md)
- [Linear GitHub Contract](./LINEAR_GITHUB_CONTRACT.md)
- [Environment Variables](./ENVIRONMENT_VARIABLES.md)
