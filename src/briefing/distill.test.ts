/**
 * Unit tests for the pure helpers in distill.ts.
 *
 * These cover the new session-history synthesis path and the merge helpers
 * that combine GitHub/Discord-derived items with session-derived items in
 * `distillBriefing`. They do not touch the database — `distillFromSessions`
 * and the merge helpers operate on plain objects, so they're tested in
 * isolation.
 */

import { describe, expect, it } from "vitest";
import {
  buildCodeSearchRepoFilter,
  distillFromSessions,
  estimateTokenSavings,
  mergeActiveIssues,
  mergeCodebaseNotes,
  mergeDecisions,
} from "./distill.js";
import type {
  ActiveIssue,
  AgentSession,
  CodebaseNote,
  Decision,
  ProjectContext,
} from "./types.js";

function session(partial: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: partial.sessionId ?? "00000000-0000-0000-0000-000000000001",
    projectId: partial.projectId ?? "owner/repo",
    startedAt: partial.startedAt ?? "2026-04-20T10:00:00.000Z",
    endedAt: partial.endedAt ?? "2026-04-20T11:00:00.000Z",
    scope: partial.scope ?? [],
    filesEdited: partial.filesEdited ?? [],
    decisionsMade: partial.decisionsMade ?? [],
    openItems: partial.openItems ?? [],
    issuesReferenced: partial.issuesReferenced ?? [],
    toolsUsed: partial.toolsUsed ?? [],
    planSteps: partial.planSteps,
    summary: partial.summary,
  };
}

describe("distillFromSessions", () => {
  it("returns empty fields when there are no sessions", () => {
    const result = distillFromSessions([]);
    expect(result).toEqual({ decisions: [], activeIssues: [], codebaseNotes: [] });
  });

  it("dedupes decisions across sessions case-insensitively", () => {
    const sessions = [
      session({
        sessionId: "s1",
        decisionsMade: ["Use Postgres for sessions", "Drop Redis dependency"],
      }),
      session({
        sessionId: "s2",
        decisionsMade: ["use postgres for sessions", "Adopt Prisma"],
      }),
    ];

    const { decisions } = distillFromSessions(sessions);

    expect(decisions.map((d) => d.what)).toEqual([
      "Use Postgres for sessions",
      "Drop Redis dependency",
      "Adopt Prisma",
    ]);
    expect(new Set(decisions.map((d) => d.what)).size).toBe(decisions.length);
  });

  it("weights activeIssues by recurrence across sessions", () => {
    const sessions = [
      session({ sessionId: "s1", openItems: ["fix flaky test", "add docs"] }),
      session({ sessionId: "s2", openItems: ["fix flaky test"] }),
      session({ sessionId: "s3", openItems: ["fix flaky test", "add docs"] }),
    ];

    const { activeIssues } = distillFromSessions(sessions);
    expect(activeIssues[0].summary).toBe("fix flaky test");
    expect(activeIssues[0].reports).toBe(3);
    expect(activeIssues[0].priority).toBe("high");
    expect(activeIssues[1].summary).toBe("add docs");
    expect(activeIssues[1].reports).toBe(2);
    expect(activeIssues[1].priority).toBe("medium");
  });

  it("includes non-completed plan steps from the most recent plan-bearing session", () => {
    const sessions = [
      session({
        sessionId: "s1",
        startedAt: "2026-04-22T10:00:00.000Z",
        planSteps: [
          { id: "1", description: "do thing", status: "pending" },
          { id: "2", description: "done thing", status: "completed" },
          { id: "3", description: "blocked thing", status: "blocked" },
        ],
      }),
    ];

    const { activeIssues } = distillFromSessions(sessions);
    const summaries = activeIssues.map((i) => i.summary);
    expect(summaries).toContain("[pending] do thing");
    expect(summaries).toContain("[blocked] blocked thing");
    expect(summaries).not.toContain("[completed] done thing");
  });

  it("filters by scope but falls back to all sessions when nothing matches", () => {
    const sessions = [
      session({
        sessionId: "in-scope",
        scope: ["billing"],
        decisionsMade: ["pick stripe"],
        openItems: ["wire up checkout"],
      }),
      session({
        sessionId: "off-scope",
        scope: ["auth"],
        decisionsMade: ["use bcrypt"],
        openItems: ["password reset flow"],
      }),
    ];

    const billing = distillFromSessions(sessions, "billing");
    expect(billing.decisions.map((d) => d.what)).toEqual(["pick stripe"]);
    expect(billing.activeIssues.map((i) => i.summary)).toEqual(["wire up checkout"]);

    const noMatch = distillFromSessions(sessions, "nonexistent-scope-token");
    expect(noMatch.decisions.length).toBe(2);
    expect(noMatch.activeIssues.length).toBe(2);
  });

  it("ranks codebase notes by edit frequency", () => {
    const sessions = [
      session({ sessionId: "s1", filesEdited: ["src/a.ts", "src/b.ts"] }),
      session({ sessionId: "s2", filesEdited: ["src/a.ts"] }),
      session({ sessionId: "s3", filesEdited: ["src/a.ts", "src/c.ts"] }),
    ];

    const { codebaseNotes } = distillFromSessions(sessions);
    expect(codebaseNotes[0].file).toBe("src/a.ts");
    expect(codebaseNotes[0].priority).toBe("high");
    expect(codebaseNotes[0].note).toBe("Edited in 3 recent sessions");
    expect(codebaseNotes.find((n) => n.file === "src/b.ts")?.note).toBe("Edited in 1 recent session");
  });

  it("ignores blank decisions, openItems, and filesEdited", () => {
    const sessions = [
      session({
        sessionId: "s1",
        decisionsMade: ["", "  ", "real decision"],
        openItems: ["", "real open item"],
        filesEdited: ["", "  ", "src/real.ts"],
      }),
    ];

    const result = distillFromSessions(sessions);
    expect(result.decisions.map((d) => d.what)).toEqual(["real decision"]);
    expect(result.activeIssues.map((i) => i.summary)).toEqual(["real open item"]);
    expect(result.codebaseNotes.map((n) => n.file)).toEqual(["src/real.ts"]);
  });
});

describe("merge helpers", () => {
  it("mergeDecisions keeps primary first and skips case-insensitive duplicates", () => {
    const primary: Decision[] = [
      { what: "Move to Postgres", why: "perf", when: "2026-04-01", status: "implemented", openItems: [] },
    ];
    const sessionDerived: Decision[] = [
      { what: "move to postgres", why: "from session", when: "2026-04-20", status: "implemented", openItems: [] },
      { what: "Adopt Prisma", why: "from session", when: "2026-04-20", status: "implemented", openItems: [] },
    ];

    const result = mergeDecisions(primary, sessionDerived);
    expect(result.map((d) => d.what)).toEqual(["Move to Postgres", "Adopt Prisma"]);
  });

  it("mergeActiveIssues caps at MAX_ACTIVE_ISSUES (10)", () => {
    const primary: ActiveIssue[] = Array.from({ length: 6 }, (_, i) => ({
      id: `#${i + 1}`,
      summary: `issue ${i + 1}`,
      reports: 1,
      source: "github",
      priority: "medium",
      labels: [],
      assignees: [],
    }));
    const sessionDerived: ActiveIssue[] = Array.from({ length: 8 }, (_, i) => ({
      id: `session-item-${i + 1}`,
      summary: `session item ${i + 1}`,
      reports: 1,
      source: "agent-session",
      priority: "medium",
      labels: [],
      assignees: [],
    }));

    const result = mergeActiveIssues(primary, sessionDerived);
    expect(result.length).toBe(10);
    expect(result.slice(0, 6).map((i) => i.summary)).toEqual(primary.map((i) => i.summary));
  });

  it("mergeCodebaseNotes deduplicates by file and case-insensitive area", () => {
    const primary: CodebaseNote[] = [
      { file: "src/a.ts", note: "from features", priority: "medium" },
      { area: "Billing", note: "from features", priority: "medium" },
    ];
    const sessionDerived: CodebaseNote[] = [
      { file: "src/a.ts", note: "Edited in 2 recent sessions", priority: "medium" },
      { area: "billing", note: "from session", priority: "high" },
      { file: "src/b.ts", note: "Edited in 1 recent session", priority: "medium" },
    ];

    const result = mergeCodebaseNotes(primary, sessionDerived);
    const files = result.map((n) => n.file).filter(Boolean);
    expect(files).toEqual(["src/a.ts", "src/b.ts"]);
    const areas = result.map((n) => n.area).filter(Boolean);
    expect(areas).toEqual(["Billing"]);
  });
});

describe("buildCodeSearchRepoFilter", () => {
  it("returns undefined when projectRepo is missing or not in owner/repo shape", () => {
    expect(buildCodeSearchRepoFilter(undefined)).toBeUndefined();
    expect(buildCodeSearchRepoFilter("")).toBeUndefined();
    expect(buildCodeSearchRepoFilter("openrundown")).toBeUndefined();
    expect(buildCodeSearchRepoFilter("owner/repo/extra")).toBeUndefined();
    expect(buildCodeSearchRepoFilter("owner repo")).toBeUndefined();
  });

  it("matches every common GitHub repo URL form for the project", () => {
    const filter = buildCodeSearchRepoFilter("Paola3stefania/openRundown");
    expect(filter).toBeDefined();
    const endsWithValues = (filter?.OR ?? [])
      .map((c) => c.repositoryUrl)
      .filter((p): p is { endsWith: string; mode: "insensitive" } => "endsWith" in p)
      .map((p) => p.endsWith);
    expect(endsWithValues).toEqual([
      "/Paola3stefania/openRundown",
      "/Paola3stefania/openRundown.git",
      ":Paola3stefania/openRundown",
      ":Paola3stefania/openRundown.git",
    ]);
    const equalsValues = (filter?.OR ?? [])
      .map((c) => c.repositoryUrl)
      .filter((p): p is { equals: string; mode: "insensitive" } => "equals" in p)
      .map((p) => p.equals);
    expect(equalsValues).toEqual(["Paola3stefania/openRundown"]);
    for (const clause of filter?.OR ?? []) {
      expect(clause.repositoryUrl.mode).toBe("insensitive");
    }
  });

  it("does not produce a substring that would match a different repo with the same suffix", () => {
    // Regression guard for the original cross-project leak: a Feature indexed
    // against `better-auth/better-auth` must not match a project filter for
    // `Paola3stefania/openRundown`.
    const filter = buildCodeSearchRepoFilter("Paola3stefania/openRundown");
    const samples = [
      "https://github.com/better-auth/better-auth",
      "https://github.com/better-auth/better-auth.git",
      "git@github.com:better-auth/better-auth.git",
      "better-auth/better-auth",
    ];
    const endsWithClauses = (filter?.OR ?? [])
      .map((c) => c.repositoryUrl)
      .filter((p): p is { endsWith: string; mode: "insensitive" } => "endsWith" in p);
    const equalsClauses = (filter?.OR ?? [])
      .map((c) => c.repositoryUrl)
      .filter((p): p is { equals: string; mode: "insensitive" } => "equals" in p);

    for (const url of samples) {
      const lower = url.toLowerCase();
      const matchesAny =
        endsWithClauses.some((c) => lower.endsWith(c.endsWith.toLowerCase())) ||
        equalsClauses.some((c) => lower === c.equals.toLowerCase());
      expect(matchesAny).toBe(false);
    }
  });
});

describe("estimateTokenSavings", () => {
  const baseBriefing: ProjectContext = {
    project: "owner/repo",
    lastUpdated: "2026-04-20T12:00:00.000Z",
    decisions: [],
    activeIssues: [],
    userSignals: [],
    techSignals: [],
    codebaseNotes: [],
    recentActivity: {
      issuesOpened: 0,
      issuesClosed: 0,
      prsOpened: 0,
      prsMerged: 0,
      discordThreads: 0,
      period: "last 14 days",
    },
    preferences: {},
  };

  it("returns a 1:1 ratio when there are no sessions", () => {
    const result = estimateTokenSavings(baseBriefing, []);
    expect(result.estimatedSourceTokens).toBe(0);
    expect(result.estimatedSavedTokens).toBe(0);
    expect(result.compressionRatio).toBe("1:1");
  });

  it("reports a positive saved-token count and ratio for a verbose session set", () => {
    const longSummary = "x".repeat(2000);
    const sessions: AgentSession[] = Array.from({ length: 5 }, (_, i) =>
      session({
        sessionId: `s${i}`,
        scope: ["scope-a", "scope-b"],
        decisionsMade: ["decision " + "y".repeat(120), "another decision " + "z".repeat(120)],
        openItems: ["open " + "q".repeat(80), "open " + "r".repeat(80)],
        filesEdited: ["src/long/path/file.ts", "src/another/long/path/file.ts"],
        summary: longSummary,
      }),
    );

    const result = estimateTokenSavings(baseBriefing, sessions);
    expect(result.estimatedSourceTokens).toBeGreaterThan(result.briefingTokens);
    expect(result.estimatedSavedTokens).toBe(result.estimatedSourceTokens - result.briefingTokens);
    expect(result.compressionRatio).toMatch(/^\d+:1$/);
    expect(result.method).toBe("approx-chars-per-token");
  });
});
