/**
 * Agent Briefing System types
 *
 * Defines the `project.context` format — a compact, structured payload
 * optimized for agent consumption. An agent reads this in ~300-500 tokens
 * and instantly knows what a human would take 30 minutes to explain.
 */

export interface ProjectContext {
  project: string;
  focus?: string;
  lastUpdated: string;
  decisions: Decision[];
  activeIssues: ActiveIssue[];
  userSignals: UserSignal[];
  techSignals: TechSignal[];
  codebaseNotes: CodebaseNote[];
  recentActivity: RecentActivity;
  preferences: Record<string, string>;
  /**
   * Top incomplete plan steps from recent sessions, ranked by recency × scope
   * match. The next agent's "what does Paola want me to do first?" queue.
   * See {@link ActionableItem}.
   */
  actionable: ActionableItem[];
  /**
   * Memories semantically related to the current focus (scope, plan steps,
   * open items). Reuses MemoryEntryEmbedding for ranking. See
   * {@link RelatedInsight}.
   */
  relatedInsights: RelatedInsight[];
}

/**
 * A pending/in_progress/blocked plan step from a recent session, lifted into
 * the briefing as an actionable handoff item. Carries enough context for the
 * next agent to decide whether to pick it up without reading the full session.
 */
export interface ActionableItem {
  id: string;
  description: string;
  status: Exclude<PlanStepStatus, "completed">;
  notes?: string;
  sessionId: string;
  sessionStartedAt: string;
  sessionScope: string[];
  /**
   * Heuristic score in [0, 1]. Recency × scope-match × status weight. Higher =
   * more likely to be relevant to the agent's current task.
   */
  score: number;
}

/**
 * A memory entry surfaced into the briefing because it's semantically related
 * to the current focus. Includes a similarity score so consumers can decide
 * whether to display or filter further.
 *
 * When `source === "session"` and `sessionId` is set, the next agent can
 * fetch the originating session via `get_session_history({ session_id })`
 * to see the full context that produced the insight. That's the navigable
 * back-link the previous roadmap session called out as missing.
 */
export interface RelatedInsight {
  memoryId: string;
  summary: string;
  tags: string[];
  createdAt: string;
  /** Cosine similarity to the focus query embedding, in [-1, 1]. */
  similarity: number;
  /** "conversation" | "manual" | "session" — see MemoryEntry.source. */
  source: string;
  /** When the memory was authored by `end_agent_session({ related_insights })`. */
  sessionId?: string;
}

/**
 * Typed pointer to an artifact living on another surface (slack thread,
 * notion page, github PR, linear issue, file, ...). Stored on
 * {@link AgentSession.externalRefs} via the `link_external_event` MCP tool.
 *
 * The discriminator is `kind`; everything else is structural. We keep `text`
 * as the human-readable label (so the briefing can render it without needing
 * to deref) and `url` as the canonical link.
 */
export type ExternalRef =
  | {
      kind: "slack_thread";
      text: string;
      url: string;
      channel?: string;
      ts?: string;
      addedAt: string;
      role: ExternalRefRole;
    }
  | {
      kind: "notion_page";
      text: string;
      url: string;
      pageId?: string;
      addedAt: string;
      role: ExternalRefRole;
    }
  | {
      kind: "github_pr" | "github_issue";
      text: string;
      url: string;
      repo?: string;
      number?: number;
      addedAt: string;
      role: ExternalRefRole;
    }
  | {
      kind: "linear_issue";
      text: string;
      url: string;
      identifier?: string;
      addedAt: string;
      role: ExternalRefRole;
    }
  | {
      kind: "file";
      text: string;
      url: string;
      path?: string;
      sha?: string;
      addedAt: string;
      role: ExternalRefRole;
    }
  | {
      kind: "discord_thread";
      text: string;
      url: string;
      guildId?: string;
      channelId?: string;
      threadId?: string;
      addedAt: string;
      role: ExternalRefRole;
    }
  | {
      kind: "other";
      text: string;
      url: string;
      addedAt: string;
      role: ExternalRefRole;
    };

/**
 * What this reference represents in the session — a decision-grade artifact,
 * an open follow-up to track, or just a piece of supporting context.
 */
export type ExternalRefRole = "decision" | "open_item" | "reference";

export interface Decision {
  what: string;
  why: string;
  when: string;
  status: "proposed" | "implemented" | "reverted";
  openItems: string[];
}

export interface ActiveIssue {
  id: string;
  summary: string;
  reports: number;
  source: string;
  priority: "critical" | "high" | "medium" | "low";
  labels: string[];
  assignees: string[];
}

export interface UserSignal {
  theme: string;
  count: number;
  period: string;
  summary: string;
  sources: string[];
}

export interface TechSignal {
  theme: string;
  tweetCount: number;
  topAuthors: string[];
  engagement: number;
  summary: string;
}

export interface CodebaseNote {
  file?: string;
  area?: string;
  note: string;
  priority: "high" | "medium" | "low";
}

export interface RecentActivity {
  issuesOpened: number;
  issuesClosed: number;
  prsOpened: number;
  prsMerged: number;
  discordThreads: number;
  period: string;
}

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface PlanStep {
  id: string;
  description: string;
  status: PlanStepStatus;
  notes?: string;
}

export interface AgentSession {
  sessionId: string;
  projectId: string;
  startedAt: string;
  endedAt?: string;
  scope: string[];
  filesEdited: string[];
  decisionsMade: string[];
  openItems: string[];
  issuesReferenced: string[];
  toolsUsed: string[];
  planSteps?: PlanStep[];
  externalRefs?: ExternalRef[];
  summary?: string;
}

export interface BriefingOptions {
  scope?: string;
  since?: string;
  project?: string;
  repo?: string;
  maxTokens?: number;
}
