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

import { prisma } from "../storage/db/prisma.js";
import { detectProjectId } from "../config/project.js";
import type { AgentSession } from "./types.js";

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
    summary?: string;
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
      summary: updates.summary ?? null,
    },
  });

  return mapSession(session);
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
    summary: string;
  }>,
): Promise<AgentSession> {
  const existing = await prisma.agentSession.findUniqueOrThrow({
    where: { id: sessionId },
  });

  const mergeArrays = (existing: string[], incoming?: string[]) =>
    incoming ? [...new Set([...existing, ...incoming])] : existing;

  const session = await prisma.agentSession.update({
    where: { id: sessionId },
    data: {
      scope: mergeArrays(existing.scope, updates.scope),
      filesEdited: mergeArrays(existing.filesEdited, updates.filesEdited),
      decisionsMade: mergeArrays(existing.decisionsMade, updates.decisionsMade),
      openItems: mergeArrays(existing.openItems, updates.openItems),
      issuesReferenced: mergeArrays(existing.issuesReferenced, updates.issuesReferenced),
      toolsUsed: mergeArrays(existing.toolsUsed, updates.toolsUsed),
      summary: updates.summary ?? existing.summary,
    },
  });

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
    summary: session.summary ?? undefined,
  };
}
