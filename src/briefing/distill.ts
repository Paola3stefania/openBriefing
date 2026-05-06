/**
 * Distillation Layer
 *
 * Compresses OpenRundown's rich data (issues, groups, threads, signals, features)
 * into a compact `project.context` JSON payload (~300-500 tokens) that an
 * agent can consume at session start.
 *
 * The intelligence is in what we leave out, not what we put in.
 */

import { prisma } from "../storage/db/prisma.js";
import { detectProjectId } from "../config/project.js";
import { getRecentSessions } from "./sessions.js";
import { getProjectChatWorkspaceIds } from "./projectScope.js";
import type {
  ProjectContext,
  ActionableItem,
  ActiveIssue,
  AgentSession,
  UserSignal,
  TechSignal,
  CodebaseNote,
  Decision,
  RecentActivity,
  RelatedInsight,
  BriefingOptions,
  PlanStep,
} from "./types.js";

const DEFAULT_LOOKBACK_DAYS = 14;
const MAX_ACTIVE_ISSUES = 10;
const MAX_USER_SIGNALS = 5;
const MAX_CODEBASE_NOTES = 5;
const MAX_DECISIONS = 5;
const MAX_TECH_SIGNALS = 5;
const MAX_ACTIONABLE = 5;
const MAX_RELATED_INSIGHTS = 5;
const RELATED_INSIGHT_MIN_SIMILARITY = 0.3;
const SESSION_HISTORY_LIMIT = 15;

export async function distillBriefing(options: BriefingOptions = {}): Promise<ProjectContext> {
  const { briefing } = await distillBriefingWithSessions(options);
  return briefing;
}

/**
 * Same as `distillBriefing`, but returns the underlying recent sessions list
 * alongside the briefing so callers (e.g. the MCP handler computing token
 * savings) don't have to re-query the database.
 */
export async function distillBriefingWithSessions(
  options: BriefingOptions = {},
): Promise<{ briefing: ProjectContext; sessions: AgentSession[] }> {
  const since = options.since
    ? new Date(options.since)
    : new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const scope = options.scope?.toLowerCase();
  const projectId = options.project ?? detectProjectId();
  // Auto-derive `repo` from `projectId` when it looks like `owner/repo`. This
  // keeps GitHub-derived sections (issues, PRs) project-scoped instead of
  // leaking results from other repos sharing the database.
  const repo = options.repo ?? deriveRepoFromProjectId(projectId);

  // Resolve which chat workspaces belong to this project. `undefined` means
  // no mapping is configured anywhere (preserve legacy unfiltered behavior).
  // An empty array means "this project owns no chat data" — suppress all
  // chat-derived signals (Discord, Slack, Teams, ...) so they don't leak
  // from other projects sharing the database.
  const chatWorkspaceIds = getProjectChatWorkspaceIds(projectId);

  const [
    activeIssues,
    userSignals,
    techSignals,
    codebaseNotes,
    decisions,
    recentActivity,
    preferences,
    sessions,
  ] = await Promise.all([
    distillActiveIssues(since, scope, repo),
    distillUserSignals(since, scope, chatWorkspaceIds),
    distillTechSignals(since, scope),
    distillCodebaseNotes(scope, repo),
    distillDecisions(since, scope, repo),
    distillRecentActivity(since, chatWorkspaceIds, repo),
    loadPreferences(projectId),
    getRecentSessions(SESSION_HISTORY_LIMIT, projectId),
  ]);

  const sessionDerived = distillFromSessions(sessions, scope);
  const actionable = extractActionableItems(sessions, scope);
  const relatedInsights = await distillRelatedInsights({
    projectId,
    scope,
    sessions,
    actionable,
  });

  const briefing: ProjectContext = {
    project: projectId,
    focus: scope,
    lastUpdated: new Date().toISOString(),
    decisions: mergeDecisions(decisions, sessionDerived.decisions),
    activeIssues: mergeActiveIssues(activeIssues, sessionDerived.activeIssues),
    userSignals,
    techSignals,
    codebaseNotes: mergeCodebaseNotes(codebaseNotes, sessionDerived.codebaseNotes),
    recentActivity,
    preferences,
    actionable,
    relatedInsights,
  };

  return { briefing, sessions };
}

function deriveRepoFromProjectId(projectId: string): string | undefined {
  const trimmed = projectId.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return undefined;
  return trimmed;
}

async function distillActiveIssues(since: Date, scope?: string, repo?: string): Promise<ActiveIssue[]> {
  const issues = await prisma.gitHubIssue.findMany({
    where: {
      issueState: "open",
      issueCreatedAt: { gte: since },
      ...(repo ? { issueRepo: repo } : {}),
      ...(scope
        ? {
            OR: [
              { issueTitle: { contains: scope, mode: "insensitive" } },
              { issueBody: { contains: scope, mode: "insensitive" } },
              { issueLabels: { has: scope } },
            ],
          }
        : {}),
    },
    include: {
      threadMatches: true,
    },
    orderBy: [{ issueCreatedAt: "desc" }],
    take: MAX_ACTIVE_ISSUES * 2,
  });

  const scored = issues.map((issue) => {
    const threadReports = issue.threadMatches.length;
    const hasLabels = issue.detectedLabels.length > 0;
    const isBug = issue.detectedLabels.includes("bug") || issue.issueLabels.includes("bug");
    const isSecurity = issue.detectedLabels.includes("security");
    const isRegression = issue.detectedLabels.includes("regression");
    const hasAssignees = issue.issueAssignees.length > 0;
    const reactionCount = getReactionCount(issue.issueReactions);

    let priority: ActiveIssue["priority"] = "medium";
    if (isSecurity || isRegression) priority = "critical";
    else if (isBug && (threadReports >= 3 || reactionCount >= 5)) priority = "high";
    else if (isBug || threadReports >= 2) priority = "high";
    else if (hasAssignees || hasLabels) priority = "medium";
    else priority = "low";

    const priorityWeight =
      priority === "critical" ? 4 : priority === "high" ? 3 : priority === "medium" ? 2 : 1;
    const score = priorityWeight * 10 + threadReports * 3 + reactionCount;

    return { issue, threadReports, priority, score, allLabels: [...issue.issueLabels, ...issue.detectedLabels] };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, MAX_ACTIVE_ISSUES).map(({ issue, threadReports, priority, allLabels }) => ({
    id: `#${issue.issueNumber}`,
    summary: issue.issueTitle,
    reports: threadReports + 1,
    source: threadReports > 0 ? "github + discord" : "github",
    priority,
    labels: [...new Set(allLabels)].slice(0, 5),
    assignees: issue.issueAssignees,
  }));
}

async function distillUserSignals(
  since: Date,
  scope?: string,
  chatWorkspaceIds?: string[],
): Promise<UserSignal[]> {
  // If the operator configured per-project chat scoping for this project
  // and this project owns no workspaces, suppress chat-derived signals
  // entirely instead of leaking other projects' groups.
  if (chatWorkspaceIds && chatWorkspaceIds.length === 0) return [];

  const groups = await prisma.group.findMany({
    where: {
      createdAt: { gte: since },
      ...(chatWorkspaceIds && chatWorkspaceIds.length > 0
        ? { channel: { guildId: { in: chatWorkspaceIds } } }
        : {}),
      ...(scope
        ? {
            OR: [
              { suggestedTitle: { contains: scope, mode: "insensitive" } },
              { affectsFeatures: { path: [], not: "[]" } },
            ],
          }
        : {}),
    },
    include: {
      groupThreads: true,
    },
    orderBy: [{ threadCount: "desc" }],
    take: MAX_USER_SIGNALS * 3,
  });

  const signals: UserSignal[] = groups
    .filter((g) => g.threadCount >= 2)
    .slice(0, MAX_USER_SIGNALS)
    .map((group) => {
      const features = Array.isArray(group.affectsFeatures) ? group.affectsFeatures : [];
      const featureNames = features
        .filter((f): f is { id: string; name: string } => typeof f === "object" && f !== null && "name" in f)
        .map((f) => f.name);

      return {
        theme: group.suggestedTitle,
        count: group.threadCount,
        period: `since ${since.toISOString().split("T")[0]}`,
        summary: featureNames.length > 0
          ? `Affects: ${featureNames.join(", ")}`
          : `${group.threadCount} related threads grouped`,
        sources: group.githubIssueNumber
          ? ["discord", "github"]
          : ["discord"],
      };
    });

  return signals;
}

/**
 * Build a Prisma `where` clause that matches `CodeSearch` rows belonging to
 * `projectRepo` (an `owner/repo` identifier).
 *
 * `CodeSearch.repositoryUrl` is written by `index_codebase` /
 * `index_code_for_features` and may take any of these forms:
 *   - `https://github.com/owner/repo`            (HTTPS clone URL)
 *   - `https://github.com/owner/repo.git`        (HTTPS with .git suffix)
 *   - `git@github.com:owner/repo`                (SSH clone URL)
 *   - `git@github.com:owner/repo.git`            (SSH with .git suffix)
 *   - `owner/repo`                               (short form from GITHUB_REPO_URL)
 *   - an absolute filesystem path like `/Users/me/Projects/repo` (LOCAL_REPO_PATH)
 *
 * We match the GitHub-style forms exhaustively (case-insensitive) plus the
 * exact short form. Local-path-only entries are intentionally excluded — we
 * have no reliable way to map an arbitrary filesystem path back to a GitHub
 * `owner/repo` without false positives, and surfacing the wrong repo's files
 * is the bug we are fixing.
 *
 * Returns `undefined` when `projectRepo` is missing or not in `owner/repo`
 * shape, which preserves the legacy unfiltered behavior so projects that
 * pass a folder-name `projectId` (no slash) still get codebase notes.
 */
export function buildCodeSearchRepoFilter(
  projectRepo: string | undefined,
):
  | {
      OR: Array<{
        repositoryUrl:
          | { endsWith: string; mode: "insensitive" }
          | { equals: string; mode: "insensitive" };
      }>;
    }
  | undefined {
  if (!projectRepo) return undefined;
  const trimmed = projectRepo.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return undefined;
  const slash = `/${trimmed}`;
  const colon = `:${trimmed}`;
  return {
    OR: [
      { repositoryUrl: { endsWith: slash, mode: "insensitive" } },
      { repositoryUrl: { endsWith: `${slash}.git`, mode: "insensitive" } },
      { repositoryUrl: { endsWith: colon, mode: "insensitive" } },
      { repositoryUrl: { endsWith: `${colon}.git`, mode: "insensitive" } },
      { repositoryUrl: { equals: trimmed, mode: "insensitive" } },
    ],
  };
}

async function distillCodebaseNotes(scope?: string, projectRepo?: string): Promise<CodebaseNote[]> {
  const notes: CodebaseNote[] = [];

  // Per-project scoping: `Feature` rows have no `projectId` column and are
  // shared across every repo indexed against this database. Without filtering
  // on the indexed repo, briefings for project A leak feature/code notes
  // pointing at files in project B's repo (e.g. `packages/better-auth/...`
  // surfacing in an `openRundown` briefing). We filter through the join chain
  // `FeatureCodeMapping → CodeSection → CodeFile → CodeSearch.repositoryUrl`.
  const repoFilter = buildCodeSearchRepoFilter(projectRepo);
  const mappingFilter = repoFilter
    ? { codeSection: { codeFile: { codeSearch: repoFilter } } }
    : undefined;

  const features = await prisma.feature.findMany({
    where: {
      ...(scope
        ? {
            OR: [
              { name: { contains: scope, mode: "insensitive" } },
              { relatedKeywords: { has: scope } },
            ],
          }
        : {}),
      // Only consider features that actually have at least one mapping into
      // *this* project's indexed code. Drops Features whose mappings live
      // entirely in other repos.
      ...(mappingFilter ? { codeMappings: { some: mappingFilter } } : {}),
    },
    include: {
      codeMappings: {
        // Filter the included mappings too, so we don't render file paths
        // from another repo even when a Feature is shared across repos.
        where: mappingFilter,
        include: {
          codeSection: {
            include: {
              codeFile: true,
            },
          },
        },
        orderBy: { similarity: "desc" },
        take: 3,
      },
    },
    take: 10,
  });

  for (const feature of features) {
    if (feature.codeMappings.length > 0) {
      const files = feature.codeMappings.map((m) => m.codeSection.codeFile.filePath);
      const uniqueFiles = [...new Set(files)];
      if (uniqueFiles.length > 0) {
        notes.push({
          area: feature.name,
          note: `Mapped to ${uniqueFiles.length} file(s): ${uniqueFiles.slice(0, 3).join(", ")}`,
          priority: feature.priority === "high" ? "high" : "medium",
        });
      }
    }
  }

  // NOTE: `ungroupedThread` has no `projectId` column, so any global count
  // would leak Discord-classification status from other projects sharing the
  // database. Surfacing that count here is misleading; the dedicated Discord
  // classification tools should be used instead.

  return notes.slice(0, MAX_CODEBASE_NOTES);
}

async function distillDecisions(since: Date, scope?: string, repo?: string): Promise<Decision[]> {
  const decisions: Decision[] = [];

  const mergedPRs = await prisma.gitHubPullRequest.findMany({
    where: {
      prMerged: true,
      prCreatedAt: { gte: since },
      ...(repo ? { prRepo: repo } : {}),
      ...(scope
        ? {
            OR: [
              { prTitle: { contains: scope, mode: "insensitive" } },
              { prBody: { contains: scope, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: {
      linkedIssues: true,
    },
    orderBy: { prCreatedAt: "desc" },
    take: MAX_DECISIONS * 2,
  });

  for (const pr of mergedPRs) {
    const linkedIssueNumbers = pr.linkedIssues.map((i) => `#${i.issueNumber}`);
    const openItems = pr.linkedIssues
      .filter((i) => i.issueState === "open")
      .map((i) => `#${i.issueNumber} still open`);

    decisions.push({
      what: pr.prTitle,
      why: linkedIssueNumbers.length > 0
        ? `Addresses ${linkedIssueNumbers.join(", ")}`
        : "Direct improvement",
      when: pr.prCreatedAt.toISOString().split("T")[0],
      status: "implemented",
      openItems,
    });
  }

  return decisions.slice(0, MAX_DECISIONS);
}

async function distillRecentActivity(
  since: Date,
  chatWorkspaceIds?: string[],
  repo?: string,
): Promise<RecentActivity> {
  // Per-project scoping: GitHub issues/PRs share a single table across every
  // repo synced into this database. Without filtering on `issueRepo`/`prRepo`
  // these counts return global aggregates (e.g. a Paola3stefania/openRundown
  // briefing that shares the DB with better-auth/better-auth would show
  // better-auth's issue counts as if they were openRundown's). When `repo`
  // is undefined (folder-name-only projects) we keep the legacy unfiltered
  // behavior so projects without an `owner/repo` identity still get counts.
  const issueRepoFilter = repo ? { issueRepo: repo } : {};
  const prRepoFilter = repo ? { prRepo: repo } : {};

  const discordCount =
    chatWorkspaceIds && chatWorkspaceIds.length === 0
      ? Promise.resolve(0)
      : prisma.classifiedThread.count({
          where: {
            classifiedAt: { gte: since },
            ...(chatWorkspaceIds && chatWorkspaceIds.length > 0
              ? { channel: { guildId: { in: chatWorkspaceIds } } }
              : {}),
          },
        });

  const [issuesOpened, issuesClosed, prsOpened, prsMerged, discordThreads] = await Promise.all([
    prisma.gitHubIssue.count({
      where: { issueCreatedAt: { gte: since }, issueState: "open", ...issueRepoFilter },
    }),
    prisma.gitHubIssue.count({
      where: { issueUpdatedAt: { gte: since }, issueState: "closed", ...issueRepoFilter },
    }),
    prisma.gitHubPullRequest.count({
      where: { prCreatedAt: { gte: since }, ...prRepoFilter },
    }),
    prisma.gitHubPullRequest.count({
      where: { prCreatedAt: { gte: since }, prMerged: true, ...prRepoFilter },
    }),
    discordCount,
  ]);

  const days = Math.ceil((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000));
  return {
    issuesOpened,
    issuesClosed,
    prsOpened,
    prsMerged,
    discordThreads,
    period: `last ${days} days`,
  };
}

async function loadPreferences(projectId: string): Promise<Record<string, string>> {
  const lastSession = await prisma.agentSession.findFirst({
    where: { projectId },
    orderBy: { startedAt: "desc" },
    select: { scope: true },
  });

  return {
    lastScope: lastSession?.scope?.join(", ") ?? "none",
  };
}

async function distillTechSignals(since: Date, scope?: string): Promise<TechSignal[]> {
  try {
    const posts = await prisma.xPost.findMany({
      where: {
        postedAt: { gte: since },
        ...(scope
          ? { content: { contains: scope, mode: "insensitive" } }
          : {}),
      },
      orderBy: { postedAt: "desc" },
      take: 500,
    });

    if (posts.length === 0) return [];

    const themeMap = new Map<string, {
      tweets: typeof posts;
      engagement: number;
      authors: Set<string>;
    }>();

    for (const post of posts) {
      const tags = post.hashtags.length > 0 ? post.hashtags : ["general"];
      const engagement = post.likeCount + post.retweetCount + post.quoteCount;

      for (const tag of tags) {
        const key = tag.toLowerCase();
        const existing = themeMap.get(key);
        if (existing) {
          existing.tweets.push(post);
          existing.engagement += engagement;
          existing.authors.add(post.authorUsername);
        } else {
          themeMap.set(key, {
            tweets: [post],
            engagement,
            authors: new Set([post.authorUsername]),
          });
        }
      }
    }

    const themes = [...themeMap.entries()]
      .filter(([, data]) => data.tweets.length >= 2)
      .sort((a, b) => b[1].engagement - a[1].engagement)
      .slice(0, MAX_TECH_SIGNALS);

    return themes.map(([theme, data]) => {
      const topAuthors = [...data.authors]
        .map((username) => {
          const authorPosts = data.tweets.filter((t) => t.authorUsername === username);
          const totalFollowers = Math.max(...authorPosts.map((t) => t.authorFollowers));
          return { username, followers: totalFollowers };
        })
        .sort((a, b) => b.followers - a.followers)
        .slice(0, 3)
        .map((a) => a.username);

      const topPost = data.tweets
        .sort((a, b) =>
          (b.likeCount + b.retweetCount + b.quoteCount) -
          (a.likeCount + a.retweetCount + a.quoteCount),
        )[0];

      return {
        theme: `#${theme}`,
        tweetCount: data.tweets.length,
        topAuthors,
        engagement: data.engagement,
        summary: topPost
          ? `Top post by @${topPost.authorUsername}: "${topPost.content.slice(0, 120)}..."`
          : `${data.tweets.length} posts from ${data.authors.size} authors`,
      };
    });
  } catch {
    return [];
  }
}

function getReactionCount(reactions: unknown): number {
  if (!reactions || typeof reactions !== "object") return 0;
  const r = reactions as Record<string, unknown>;
  let total = 0;
  for (const key of Object.keys(r)) {
    const val = r[key];
    if (typeof val === "number") total += val;
  }
  return total;
}

/**
 * Build a focus query string from the agent's current context — scope,
 * incomplete plan steps, and open items from recent sessions. Used as the
 * input to the embedding-based memory ranker so `relatedInsights` reflects
 * what the agent is actually about to work on, not just project-global
 * memories.
 *
 * Exported for testability.
 */
export function buildFocusQuery(input: {
  scope?: string;
  actionable?: ActionableItem[];
  sessions?: AgentSession[];
}): string {
  const parts: string[] = [];
  if (input.scope) parts.push(input.scope);
  if (input.actionable) {
    for (const item of input.actionable.slice(0, 5)) {
      parts.push(item.description);
      if (item.notes) parts.push(item.notes);
    }
  }
  if (input.sessions) {
    for (const session of input.sessions.slice(0, 3)) {
      for (const item of session.openItems.slice(0, 3)) parts.push(item);
      if (session.summary) parts.push(session.summary);
    }
  }
  return parts.filter((p) => p && p.trim().length > 0).join("\n").trim();
}

/**
 * Surface memories that are semantically related to the agent's current
 * focus. Reuses the `MemoryEntry` + `MemoryEntryEmbedding` tables so
 * `save_memory` writes (or future automated ingestion) feed straight into
 * the briefing's `relatedInsights` field — no extra retrieval round-trip
 * required by the agent.
 *
 * Behavior:
 *   - Only ever queries memories scoped to `projectId` (no cross-project leak).
 *   - Best-effort: if `OPENAI_API_KEY` is missing or embedding generation
 *     fails, returns `[]` rather than failing the whole briefing.
 *   - If the focus query is empty (no scope, no plan steps, no open items),
 *     skips entirely — random "recent memories" would be noise here, not
 *     signal. Use `get_recent_memories` for that view.
 *   - Filters by `RELATED_INSIGHT_MIN_SIMILARITY` to avoid surfacing
 *     barely-related memories as if they were relevant.
 */
async function distillRelatedInsights(input: {
  projectId: string;
  scope?: string;
  sessions: AgentSession[];
  actionable: ActionableItem[];
}): Promise<RelatedInsight[]> {
  const focusQuery = buildFocusQuery({
    scope: input.scope,
    actionable: input.actionable,
    sessions: input.sessions,
  });
  if (focusQuery.length === 0) return [];

  const apiKey = process.env.OPENAI_API_KEY ?? null;
  if (!apiKey) return [];

  let queryEmbedding: number[];
  try {
    const { createEmbedding } = await import("../core/classify/semantic.js");
    queryEmbedding = await createEmbedding(focusQuery, apiKey);
  } catch (err) {
    console.error("[Briefing] relatedInsights: failed to embed focus query", err);
    return [];
  }

  const entries = await prisma.memoryEntry.findMany({
    where: { projectId: input.projectId },
    include: { embedding: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const ranked: RelatedInsight[] = [];
  for (const entry of entries) {
    if (!entry.embedding) continue;
    const vec = entry.embedding.embedding as number[];
    if (!Array.isArray(vec) || vec.length !== queryEmbedding.length) continue;
    const similarity = cosineSimilarity(queryEmbedding, vec);
    if (similarity < RELATED_INSIGHT_MIN_SIMILARITY) continue;
    ranked.push({
      memoryId: entry.id,
      summary: entry.summary,
      tags: entry.tags,
      createdAt: entry.createdAt.toISOString(),
      similarity: Number(similarity.toFixed(3)),
      source: entry.source,
      // Read defensively: the field is a real column on `MemoryEntry`, but we
      // want to tolerate IDE language servers running with a stale prisma
      // client until they reload. tsc on the CLI proves the type is correct.
      sessionId:
        (entry as { sessionId?: string | null }).sessionId ?? undefined,
    });
  }

  return ranked
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, MAX_RELATED_INSIGHTS);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Approximate token savings between raw session payloads and the produced
 * briefing. Uses the rough `chars / 4` heuristic — not a tokenizer-accurate
 * count, but good enough for an order-of-magnitude indicator and avoids
 * pulling in a tokenizer dependency just for telemetry.
 */
export interface TokenSavings {
  estimatedSourceTokens: number;
  briefingTokens: number;
  estimatedSavedTokens: number;
  compressionRatio: string;
  method: "approx-chars-per-token";
}

const APPROX_CHARS_PER_TOKEN = 4;

function approxTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function approxSessionTokens(sessions: AgentSession[]): number {
  let chars = 0;
  for (const s of sessions) {
    chars += s.summary?.length ?? 0;
    for (const arr of [s.scope, s.decisionsMade, s.openItems, s.filesEdited, s.issuesReferenced, s.toolsUsed]) {
      for (const entry of arr) chars += entry.length + 1;
    }
    if (s.planSteps) {
      for (const step of s.planSteps) {
        chars += step.description.length + step.id.length + step.status.length;
        if (step.notes) chars += step.notes.length;
      }
    }
  }
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}

export function estimateTokenSavings(
  briefing: ProjectContext,
  sessions: AgentSession[],
): TokenSavings {
  const sourceTokens = approxSessionTokens(sessions);
  const briefingTokens = approxTokens(JSON.stringify(briefing));
  const saved = Math.max(0, sourceTokens - briefingTokens);
  const ratio = briefingTokens > 0 && sourceTokens > briefingTokens
    ? `${Math.round(sourceTokens / briefingTokens)}:1`
    : "1:1";

  return {
    estimatedSourceTokens: sourceTokens,
    briefingTokens,
    estimatedSavedTokens: saved,
    compressionRatio: ratio,
    method: "approx-chars-per-token",
  };
}


/**
 * Synthesize structured briefing fields from recent agent session history.
 *
 * The classified-data path (`distillActiveIssues` / `distillDecisions` /
 * `distillCodebaseNotes`) only fires when GitHub issues, PRs, and feature
 * mappings have been ingested. Most projects using OpenRundown for session
 * memory have neither. Without a session-history fallback the briefing's
 * structured arrays come back empty even when end_agent_session records
 * contain the very data the agent is asking for.
 *
 * This helper extracts:
 *   - `decisions` from `decisionsMade[]` across sessions (deduped)
 *   - `activeIssues` from `openItems[]` (deduped, weighted by recurrence) and
 *     non-completed entries from the most recent session's `planSteps`
 *   - `codebaseNotes` from frequently-edited files in `filesEdited[]`
 *
 * Scope filtering is permissive: a session is "in scope" if any of its
 * `scope` / `decisionsMade` / `openItems` / `filesEdited` text matches.
 * If no sessions match scope, fall back to all recent sessions so the agent
 * still sees something useful.
 */
/**
 * Lift incomplete plan steps from recent sessions into a ranked, actionable
 * queue surfaced on the briefing. The next agent's "what should I pick up
 * first?" answer.
 *
 * Ranking: each step gets a score in [0, 1] based on:
 *   - status weight (in_progress > blocked > pending)
 *   - recency (newer sessions matter more — exponential decay over ~30 days)
 *   - scope match (if a `scope` is passed, sessions/steps that mention it
 *     get a boost; otherwise this factor is constant)
 *
 * Already-completed steps are dropped. Steps with the same description across
 * sessions are deduplicated (latest occurrence wins).
 */
export function extractActionableItems(
  sessions: AgentSession[],
  scope?: string,
  now: Date = new Date(),
): ActionableItem[] {
  if (sessions.length === 0) return [];

  const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const STATUS_WEIGHTS: Record<PlanStep["status"], number> = {
    in_progress: 1.0,
    blocked: 0.9,
    pending: 0.7,
    completed: 0,
  };

  const scopeLower = scope?.toLowerCase();
  const candidates = new Map<string, ActionableItem>();

  for (const session of sessions) {
    const steps = session.planSteps ?? [];
    if (steps.length === 0) continue;

    const startedMs = Date.parse(session.startedAt);
    const ageMs = Number.isFinite(startedMs)
      ? Math.max(0, now.getTime() - startedMs)
      : RECENCY_HALF_LIFE_MS;
    const recency = Math.exp(-ageMs / RECENCY_HALF_LIFE_MS);

    const sessionHaystack = [
      ...session.scope,
      ...session.decisionsMade,
      ...session.openItems,
      ...steps.map((s) => s.description),
    ]
      .join("\n")
      .toLowerCase();

    for (const step of steps) {
      if (step.status === "completed") continue;
      const desc = step.description.trim();
      if (desc.length === 0) continue;

      const statusWeight = STATUS_WEIGHTS[step.status] ?? 0.5;
      const scopeMatch = scopeLower
        ? sessionHaystack.includes(scopeLower) ||
          desc.toLowerCase().includes(scopeLower)
          ? 1
          : 0.6
        : 1;
      const score = Math.min(1, statusWeight * recency * scopeMatch);

      const key = `${desc.toLowerCase()}::${step.status}`;
      const existing = candidates.get(key);
      if (!existing || score > existing.score) {
        candidates.set(key, {
          id: step.id,
          description: desc,
          status: step.status as ActionableItem["status"],
          notes: step.notes?.trim() || undefined,
          sessionId: session.sessionId,
          sessionStartedAt: session.startedAt,
          sessionScope: session.scope,
          score: Number(score.toFixed(3)),
        });
      }
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ACTIONABLE);
}

export function distillFromSessions(
  sessions: AgentSession[],
  scope?: string,
): { decisions: Decision[]; activeIssues: ActiveIssue[]; codebaseNotes: CodebaseNote[] } {
  if (sessions.length === 0) {
    return { decisions: [], activeIssues: [], codebaseNotes: [] };
  }

  const matchesScope = (s: AgentSession): boolean => {
    if (!scope) return true;
    const haystack = [
      ...s.scope,
      ...s.decisionsMade,
      ...s.openItems,
      ...s.filesEdited,
      ...(s.planSteps?.map((p) => p.description) ?? []),
    ]
      .join("\n")
      .toLowerCase();
    return haystack.includes(scope);
  };

  const scoped = sessions.filter(matchesScope);
  const sessionsToUse = scoped.length > 0 ? scoped : sessions;

  const decisionMap = new Map<string, Decision>();
  for (const session of sessionsToUse) {
    const when = (session.endedAt ?? session.startedAt).split("T")[0];
    const why = session.scope.length > 0
      ? `Session scope: ${session.scope.join(", ")}`
      : `From session ${session.sessionId.slice(0, 8)}`;
    for (const text of session.decisionsMade) {
      const key = text.toLowerCase().trim();
      if (!key || decisionMap.has(key)) continue;
      decisionMap.set(key, {
        what: text,
        why,
        when,
        status: "implemented",
        openItems: [],
      });
    }
  }
  const decisions = [...decisionMap.values()].slice(0, MAX_DECISIONS);

  type OpenItemEntry = {
    summary: string;
    count: number;
    sessions: Set<string>;
    sources: Set<string>;
  };
  const openItemMap = new Map<string, OpenItemEntry>();
  const addOpenItem = (text: string, sessionId: string, source: string) => {
    const key = text.toLowerCase().trim();
    if (!key) return;
    const existing = openItemMap.get(key);
    if (existing) {
      existing.count += 1;
      existing.sessions.add(sessionId);
      existing.sources.add(source);
    } else {
      openItemMap.set(key, {
        summary: text,
        count: 1,
        sessions: new Set([sessionId]),
        sources: new Set([source]),
      });
    }
  };

  for (const session of sessionsToUse) {
    for (const item of session.openItems) {
      addOpenItem(item, session.sessionId, "open-item");
    }
  }

  const lastWithPlan = sessionsToUse.find((s) => (s.planSteps?.length ?? 0) > 0);
  if (lastWithPlan?.planSteps) {
    for (const step of lastWithPlan.planSteps) {
      if (step.status === "completed") continue;
      const label = `[${step.status}] ${step.description}`;
      addOpenItem(label, lastWithPlan.sessionId, "plan-step");
    }
  }

  const activeIssues: ActiveIssue[] = [...openItemMap.values()]
    .sort((a, b) => b.count - a.count || b.sessions.size - a.sessions.size)
    .slice(0, MAX_ACTIVE_ISSUES)
    .map((entry, i) => ({
      id: `session-item-${i + 1}`,
      summary: entry.summary,
      reports: entry.count,
      source: [...entry.sources].includes("plan-step") ? "agent-plan" : "agent-session",
      priority: entry.count >= 3 ? "high" : entry.count >= 2 ? "medium" : "low",
      labels: [],
      assignees: [],
    }));

  const fileMap = new Map<string, number>();
  for (const session of sessionsToUse) {
    for (const file of session.filesEdited) {
      const trimmed = file.trim();
      if (!trimmed) continue;
      fileMap.set(trimmed, (fileMap.get(trimmed) ?? 0) + 1);
    }
  }
  const codebaseNotes: CodebaseNote[] = [...fileMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CODEBASE_NOTES)
    .map(([file, count]) => ({
      file,
      note: `Edited in ${count} recent session${count === 1 ? "" : "s"}`,
      priority: count >= 3 ? "high" : "medium",
    }));

  return { decisions, activeIssues, codebaseNotes };
}

export function mergeDecisions(primary: Decision[], session: Decision[]): Decision[] {
  const seen = new Set(primary.map((d) => d.what.toLowerCase().trim()));
  const merged = [...primary];
  for (const d of session) {
    const key = d.what.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(d);
    if (merged.length >= MAX_DECISIONS) break;
  }
  return merged;
}

export function mergeActiveIssues(primary: ActiveIssue[], session: ActiveIssue[]): ActiveIssue[] {
  const seen = new Set(primary.map((i) => i.summary.toLowerCase().trim()));
  const merged = [...primary];
  for (const i of session) {
    const key = i.summary.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(i);
    if (merged.length >= MAX_ACTIVE_ISSUES) break;
  }
  return merged;
}

export function mergeCodebaseNotes(primary: CodebaseNote[], session: CodebaseNote[]): CodebaseNote[] {
  const seen = new Set<string>();
  for (const n of primary) {
    if (n.file) seen.add(`file:${n.file}`);
    if (n.area) seen.add(`area:${n.area.toLowerCase()}`);
  }
  const merged = [...primary];
  for (const n of session) {
    const fileKey = n.file ? `file:${n.file}` : undefined;
    const areaKey = n.area ? `area:${n.area.toLowerCase()}` : undefined;
    if ((fileKey && seen.has(fileKey)) || (areaKey && seen.has(areaKey))) continue;
    if (fileKey) seen.add(fileKey);
    if (areaKey) seen.add(areaKey);
    merged.push(n);
    if (merged.length >= MAX_CODEBASE_NOTES) break;
  }
  return merged;
}
