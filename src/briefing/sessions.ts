/**
 * Session Tracking
 *
 * Lightweight bookkeeping for agent sessions. Tracks what an agent worked on
 * so the next briefing can highlight what changed since the last session.
 *
 * All sessions are scoped to a projectId so multiple projects can share
 * one database without collision.
 *
 * No embeddings needed — just structured data in a simple table.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../storage/db/prisma.js";
import { detectProjectId } from "../config/project.js";
import type { AgentSession, ExternalRef, PlanStep } from "./types.js";

/**
 * How long after `endedAt` an ended session can still be amended via
 * `updateSession`. This implements "soft-end": ending a session is the
 * normal happy path, but if the agent realizes mid-handoff that something
 * important wasn't recorded, they can still append for a configurable window
 * instead of falling back to `save_memory` (which fragments retrieval).
 *
 * Configurable via `OPENBRIEFING_SESSION_AMEND_WINDOW_MS`. Default 24 hours.
 * Set to `0` to disable soft-end (sessions become immutable on `endedAt`).
 */
const DEFAULT_AMEND_WINDOW_MS = 24 * 60 * 60 * 1000;

function readAmendWindowMs(): number {
  const raw = process.env.OPENBRIEFING_SESSION_AMEND_WINDOW_MS;
  if (raw === undefined || raw === "") return DEFAULT_AMEND_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AMEND_WINDOW_MS;
  return parsed;
}

/**
 * Returns true if the session is currently amendable: still running, OR ended
 * within the configured soft-end window.
 */
export function isSessionAmendable(
  endedAt: Date | null | undefined,
  now: Date = new Date(),
  windowMs: number = readAmendWindowMs(),
): boolean {
  if (!endedAt) return true;
  if (windowMs <= 0) return false;
  return now.getTime() - endedAt.getTime() <= windowMs;
}

export async function startSession(
  scope: string[] = [],
  projectId?: string,
): Promise<AgentSession> {
  const pid = projectId ?? detectProjectId();
  const session = await prisma.agentSession.create({
    data: {
      projectId: pid,
      scope,
      startedAt: new Date(),
    },
  });

  return mapSession(session);
}

export async function endSession(
  sessionId: string,
  updates: {
    filesEdited?: string[];
    decisionsMade?: string[];
    openItems?: string[];
    issuesReferenced?: string[];
    toolsUsed?: string[];
    planSteps?: PlanStep[];
    summary?: string;
    /**
     * Free-form debrief insights to persist as session-linked memories.
     * Each entry becomes a `MemoryEntry` row with `source: "session"`,
     * tagged with the session id, and embedded for semantic retrieval.
     * The next briefing's `relatedInsights[]` will surface them when
     * they match the agent's focus query.
     *
     * This is the primary mechanism for narrowing the memory-vs-session
     * bifurcation: the canonical work record (session) and the retrievable
     * insight (memory) come from a single tool call.
     */
    relatedInsights?: string[];
  } = {},
): Promise<AgentSession> {
  const session = await prisma.agentSession.update({
    where: { id: sessionId },
    data: {
      endedAt: new Date(),
      filesEdited: updates.filesEdited ?? [],
      decisionsMade: updates.decisionsMade ?? [],
      openItems: updates.openItems ?? [],
      issuesReferenced: updates.issuesReferenced ?? [],
      toolsUsed: updates.toolsUsed ?? [],
      ...(updates.planSteps !== undefined && {
        planSteps: updates.planSteps as unknown as Prisma.InputJsonValue,
      }),
      summary: updates.summary ?? null,
    },
  });

  // Best-effort fan-out: if the caller passed `relatedInsights`, persist them
  // as session-linked memories. Failures are logged inside saveSessionInsights
  // and never block end_session (a partial save is better than losing the
  // canonical session record because OpenAI was momentarily down).
  if (updates.relatedInsights && updates.relatedInsights.length > 0) {
    const { saveSessionInsights } = await import("../storage/db/memory.js");
    await saveSessionInsights({
      sessionId,
      projectId: session.projectId,
      insights: updates.relatedInsights,
    });
  }

  return mapSession(session);
}

export class SessionAmendmentExpiredError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly endedAt: Date,
    public readonly windowMs: number,
  ) {
    super(
      `Session ${sessionId} ended at ${endedAt.toISOString()} and the soft-end ` +
        `amendment window of ${windowMs}ms has expired. Start a new session and ` +
        `reference this one in its scope/summary.`,
    );
    this.name = "SessionAmendmentExpiredError";
  }
}

export async function updateSession(
  sessionId: string,
  updates: Partial<{
    scope: string[];
    filesEdited: string[];
    decisionsMade: string[];
    openItems: string[];
    issuesReferenced: string[];
    toolsUsed: string[];
    planSteps: PlanStep[];
    externalRefs: ExternalRef[];
    summary: string;
  }>,
): Promise<AgentSession> {
  const existing = await prisma.agentSession.findUniqueOrThrow({
    where: { id: sessionId },
  });

  // Soft-end: allow amendments for a configurable window after `endedAt`.
  // Throws `SessionAmendmentExpiredError` if the window has lapsed so callers
  // can give the agent a useful message instead of a generic Prisma error.
  if (!isSessionAmendable(existing.endedAt)) {
    throw new SessionAmendmentExpiredError(
      sessionId,
      existing.endedAt as Date,
      readAmendWindowMs(),
    );
  }

  const mergeArrays = (existing: string[], incoming?: string[]) =>
    incoming ? [...new Set([...existing, ...incoming])] : existing;

  const mergedPlanSteps = mergePlanSteps(
    parsePlanSteps(existing.planSteps),
    updates.planSteps,
  );

  const mergedExternalRefs = mergeExternalRefs(
    parseExternalRefs(existing.externalRefs),
    updates.externalRefs,
  );

  const session = await prisma.agentSession.update({
    where: { id: sessionId },
    data: {
      scope: mergeArrays(existing.scope, updates.scope),
      filesEdited: mergeArrays(existing.filesEdited, updates.filesEdited),
      decisionsMade: mergeArrays(existing.decisionsMade, updates.decisionsMade),
      openItems: mergeArrays(existing.openItems, updates.openItems),
      issuesReferenced: mergeArrays(existing.issuesReferenced, updates.issuesReferenced),
      toolsUsed: mergeArrays(existing.toolsUsed, updates.toolsUsed),
      ...(mergedPlanSteps !== undefined && {
        planSteps: mergedPlanSteps as unknown as Prisma.InputJsonValue,
      }),
      ...(mergedExternalRefs !== undefined && {
        externalRefs: mergedExternalRefs as unknown as Prisma.InputJsonValue,
      }),
      summary: updates.summary ?? existing.summary,
    },
  });

  return mapSession(session);
}

/**
 * Append a typed external reference to a session's `externalRefs`. Used by
 * the `link_external_event` MCP tool. Honors the soft-end window so an agent
 * can attach a Slack thread reference to a session it already ended a few
 * hours ago.
 */
export async function appendExternalRef(
  sessionId: string,
  ref: ExternalRef,
): Promise<AgentSession> {
  return updateSession(sessionId, { externalRefs: [ref] });
}

/**
 * Find the session a `link_external_event` (or similar implicit-target tool)
 * call should attach to: the most recent session for `projectId` that is
 * still amendable (running OR ended within the soft-end window). Returns
 * `null` if there is no such session — callers should surface a clear
 * "start a session first" error instead of silently writing nowhere.
 */
export async function findActiveSessionForProject(
  projectId: string,
): Promise<AgentSession | null> {
  const session = await prisma.agentSession.findFirst({
    where: { projectId },
    orderBy: { startedAt: "desc" },
  });
  if (!session) return null;
  if (!isSessionAmendable(session.endedAt)) return null;
  return mapSession(session);
}

export async function getSession(sessionId: string): Promise<AgentSession | null> {
  const session = await prisma.agentSession.findUnique({
    where: { id: sessionId },
  });
  return session ? mapSession(session) : null;
}

export async function getRecentSessions(
  limit = 5,
  projectId?: string,
): Promise<AgentSession[]> {
  const pid = projectId ?? detectProjectId();
  const sessions = await prisma.agentSession.findMany({
    where: { projectId: pid },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  return sessions.map(mapSession);
}

/**
 * Auto-close sessions that were started but never properly ended.
 * A session is "stale" if endedAt is null and it hasn't been touched
 * (started or updated) within the threshold (default: 1 hour).
 * Using updatedAt means actively-updated long sessions won't be reaped.
 */
export async function closeStaleSessions(
  projectId?: string,
  maxAgeMs = 60 * 60 * 1000,
): Promise<number> {
  const pid = projectId ?? detectProjectId();
  const cutoff = new Date(Date.now() - maxAgeMs);

  const stale = await prisma.agentSession.findMany({
    where: {
      projectId: pid,
      endedAt: null,
      updatedAt: { lt: cutoff },
    },
    select: { id: true, startedAt: true, updatedAt: true },
  });

  if (stale.length === 0) return 0;

  await prisma.agentSession.updateMany({
    where: { id: { in: stale.map((s) => s.id) } },
    data: {
      endedAt: new Date(),
      summary: "Auto-closed: session was never properly ended.",
    },
  });

  console.error(`[Session] Auto-closed ${stale.length} stale session(s) for project "${pid}"`);
  return stale.length;
}

export async function getLastSession(projectId?: string): Promise<AgentSession | null> {
  const pid = projectId ?? detectProjectId();
  const session = await prisma.agentSession.findFirst({
    where: { projectId: pid },
    orderBy: { startedAt: "desc" },
  });
  return session ? mapSession(session) : null;
}

/**
 * Compact view of a session — optimized for listing many sessions without
 * blowing past MCP response size limits. Arrays are replaced with counts and
 * small previews; long strings (summary) are truncated.
 */
export interface AgentSessionSummary {
  sessionId: string;
  projectId: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  scope: string[];
  summary?: string;
  summaryTruncated: boolean;
  counts: {
    filesEdited: number;
    decisionsMade: number;
    openItems: number;
    issuesReferenced: number;
    toolsUsed: number;
    planSteps: number;
  };
  openItemsPreview: string[];
  planStepsStatus: Record<PlanStep["status"], number>;
}

const SUMMARY_MAX_CHARS = 280;
const OPEN_ITEMS_PREVIEW = 5;

export function summarizeSession(session: AgentSession): AgentSessionSummary {
  const summary = session.summary ?? "";
  const summaryTruncated = summary.length > SUMMARY_MAX_CHARS;
  const planStepsStatus: Record<PlanStep["status"], number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
  };
  for (const step of session.planSteps ?? []) {
    planStepsStatus[step.status] = (planStepsStatus[step.status] ?? 0) + 1;
  }

  const startedMs = Date.parse(session.startedAt);
  const endedMs = session.endedAt ? Date.parse(session.endedAt) : undefined;

  return {
    sessionId: session.sessionId,
    projectId: session.projectId,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationMs:
      endedMs !== undefined && !Number.isNaN(startedMs) && !Number.isNaN(endedMs)
        ? endedMs - startedMs
        : undefined,
    scope: session.scope,
    summary: summaryTruncated ? `${summary.slice(0, SUMMARY_MAX_CHARS)}…` : summary || undefined,
    summaryTruncated,
    counts: {
      filesEdited: session.filesEdited.length,
      decisionsMade: session.decisionsMade.length,
      openItems: session.openItems.length,
      issuesReferenced: session.issuesReferenced.length,
      toolsUsed: session.toolsUsed.length,
      planSteps: session.planSteps?.length ?? 0,
    },
    openItemsPreview: session.openItems.slice(0, OPEN_ITEMS_PREVIEW),
    planStepsStatus,
  };
}

/**
 * Compact diff between a reference point and the current session state.
 * Designed for the `get_session_delta` MCP tool: lets a returning agent
 * load only what's *new* since their last touchpoint instead of re-pulling
 * the recent-sessions view every time.
 */
export interface SessionDelta {
  projectId: string;
  since: string;
  now: string;
  /** Sessions that started or were updated after `since`. */
  changedSessions: number;
  /** New scope tokens introduced since `since` (deduped, max 25). */
  newScope: string[];
  /** New decisions recorded since `since` (deduped, latest-first, max 20). */
  newDecisions: string[];
  /** New open items raised since `since` (deduped, latest-first, max 20). */
  newOpenItems: string[];
  /** Plan steps that flipped to `completed` since `since` (max 20). */
  completedPlanSteps: Array<{ id: string; description: string; sessionId: string }>;
  /** Plan steps still open as of `now`, lifted from sessions touched since `since` (max 20). */
  pendingPlanSteps: Array<{
    id: string;
    description: string;
    status: PlanStep["status"];
    sessionId: string;
  }>;
  /** External refs added since `since` (max 20). */
  newExternalRefs: ExternalRef[];
  /** IDs of sessions that contributed to this delta. */
  sessionIds: string[];
}

const DELTA_MAX_DECISIONS = 20;
const DELTA_MAX_OPEN_ITEMS = 20;
const DELTA_MAX_PLAN_STEPS = 20;
const DELTA_MAX_REFS = 20;
const DELTA_MAX_SCOPE = 25;

/**
 * Compute a session delta for `projectId` since the given reference point.
 *
 * `since` may be:
 *   - a sessionId (delta is computed against everything after that session's
 *     `startedAt`)
 *   - an ISO 8601 timestamp string
 *   - a Date object
 *
 * Optionally narrows by `scope` substring (case-insensitive) so an agent
 * working on auth doesn't see billing-only changes.
 */
export async function getSessionDelta(input: {
  projectId: string;
  since: string | Date;
  scope?: string;
  now?: Date;
}): Promise<SessionDelta> {
  const now = input.now ?? new Date();
  const sinceDate = await resolveSinceDate(input.since, input.projectId);
  const scopeLower = input.scope?.toLowerCase();

  const sessions = await prisma.agentSession.findMany({
    where: {
      projectId: input.projectId,
      OR: [
        { startedAt: { gt: sinceDate } },
        { updatedAt: { gt: sinceDate } },
      ],
    },
    orderBy: { startedAt: "desc" },
    take: 50,
  });

  const matchesScope = (
    haystack: string[],
  ): boolean => {
    if (!scopeLower) return true;
    return haystack.some((s) => s.toLowerCase().includes(scopeLower));
  };

  const newScope = new Set<string>();
  const newDecisions: string[] = [];
  const newOpenItems: string[] = [];
  const completedPlanSteps: SessionDelta["completedPlanSteps"] = [];
  const pendingPlanSteps: SessionDelta["pendingPlanSteps"] = [];
  const newExternalRefs: ExternalRef[] = [];
  const sessionIds: string[] = [];

  for (const session of sessions) {
    const haystack = [
      ...session.scope,
      ...session.decisionsMade,
      ...session.openItems,
    ];
    if (!matchesScope(haystack)) continue;
    sessionIds.push(session.id);

    for (const s of session.scope) {
      if (newScope.size < DELTA_MAX_SCOPE) newScope.add(s);
    }
    for (const d of session.decisionsMade) {
      if (newDecisions.length < DELTA_MAX_DECISIONS && !newDecisions.includes(d)) {
        newDecisions.push(d);
      }
    }
    for (const o of session.openItems) {
      if (newOpenItems.length < DELTA_MAX_OPEN_ITEMS && !newOpenItems.includes(o)) {
        newOpenItems.push(o);
      }
    }

    const steps = parsePlanSteps(session.planSteps) ?? [];
    for (const step of steps) {
      if (
        step.status === "completed" &&
        completedPlanSteps.length < DELTA_MAX_PLAN_STEPS
      ) {
        completedPlanSteps.push({
          id: step.id,
          description: step.description,
          sessionId: session.id,
        });
      } else if (
        step.status !== "completed" &&
        pendingPlanSteps.length < DELTA_MAX_PLAN_STEPS
      ) {
        pendingPlanSteps.push({
          id: step.id,
          description: step.description,
          status: step.status,
          sessionId: session.id,
        });
      }
    }

    const refs = parseExternalRefs(session.externalRefs) ?? [];
    for (const ref of refs) {
      if (newExternalRefs.length < DELTA_MAX_REFS && !newExternalRefs.find((r) => r.url === ref.url)) {
        newExternalRefs.push(ref);
      }
    }
  }

  return {
    projectId: input.projectId,
    since: sinceDate.toISOString(),
    now: now.toISOString(),
    changedSessions: sessionIds.length,
    newScope: [...newScope],
    newDecisions,
    newOpenItems,
    completedPlanSteps,
    pendingPlanSteps,
    newExternalRefs,
    sessionIds,
  };
}

/**
 * Resolve the `since` argument for `getSessionDelta` into a concrete Date.
 *
 * Accepts a sessionId (delta starts at that session's `startedAt`), an ISO
 * timestamp, or a Date. Falls back to "30 days ago" for unparseable inputs
 * rather than throwing — the tool should always return *something* useful.
 */
async function resolveSinceDate(
  since: string | Date,
  projectId: string,
): Promise<Date> {
  if (since instanceof Date) return since;
  // Try sessionId first (UUIDs and other id-shaped strings won't parse as
  // dates, so this disambiguates without a regex).
  const session = await prisma.agentSession.findFirst({
    where: { id: since, projectId },
    select: { startedAt: true },
  });
  if (session) return session.startedAt;

  const parsed = Date.parse(since);
  if (Number.isFinite(parsed)) return new Date(parsed);

  // Fallback: 30 days ago.
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

function parsePlanSteps(raw: unknown): PlanStep[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) return raw as PlanStep[];
  return undefined;
}

function parseExternalRefs(raw: unknown): ExternalRef[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) return raw as ExternalRef[];
  return undefined;
}

/**
 * Merge incoming plan steps with existing ones by id.
 * New steps are appended, existing steps are updated (status/notes overwrite).
 */
function mergePlanSteps(
  existing?: PlanStep[],
  incoming?: PlanStep[],
): PlanStep[] | undefined {
  if (!incoming) return existing;
  if (!existing || existing.length === 0) return incoming;

  const merged = new Map<string, PlanStep>();
  for (const step of existing) merged.set(step.id, step);
  for (const step of incoming) merged.set(step.id, { ...merged.get(step.id), ...step });
  return [...merged.values()];
}

/**
 * Merge incoming external refs with existing ones, deduplicating by `url`.
 * New refs override on the same url so a re-link can update labels/role.
 */
function mergeExternalRefs(
  existing?: ExternalRef[],
  incoming?: ExternalRef[],
): ExternalRef[] | undefined {
  if (!incoming) return existing;
  if (!existing || existing.length === 0) return incoming;

  const merged = new Map<string, ExternalRef>();
  for (const ref of existing) merged.set(ref.url, ref);
  for (const ref of incoming) merged.set(ref.url, ref);
  return [...merged.values()];
}

function mapSession(session: {
  id: string;
  projectId: string;
  startedAt: Date;
  endedAt: Date | null;
  scope: string[];
  filesEdited: string[];
  decisionsMade: string[];
  openItems: string[];
  issuesReferenced: string[];
  toolsUsed: string[];
  planSteps: unknown;
  externalRefs?: unknown;
  summary: string | null;
}): AgentSession {
  return {
    sessionId: session.id,
    projectId: session.projectId,
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt?.toISOString(),
    scope: session.scope,
    filesEdited: session.filesEdited,
    decisionsMade: session.decisionsMade,
    openItems: session.openItems,
    issuesReferenced: session.issuesReferenced,
    toolsUsed: session.toolsUsed,
    planSteps: parsePlanSteps(session.planSteps),
    externalRefs: parseExternalRefs(session.externalRefs),
    summary: session.summary ?? undefined,
  };
}
