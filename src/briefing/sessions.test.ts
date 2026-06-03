/**
 * Pure-function tests for the session helpers.
 *
 * The DB-touching paths (updateSession, getSessionDelta, ...) are integration
 * concerns; here we cover the soft-end window logic that doesn't depend on
 * Prisma so we can lock down the timing semantics without spinning up a
 * database.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSessionAmendable } from "./sessions.js";

describe("isSessionAmendable", () => {
  const ORIGINAL_ENV = process.env.OPENBRIEFING_SESSION_AMEND_WINDOW_MS;

  beforeEach(() => {
    delete process.env.OPENBRIEFING_SESSION_AMEND_WINDOW_MS;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.OPENBRIEFING_SESSION_AMEND_WINDOW_MS;
    } else {
      process.env.OPENBRIEFING_SESSION_AMEND_WINDOW_MS = ORIGINAL_ENV;
    }
  });

  it("treats running sessions (endedAt = null/undefined) as always amendable", () => {
    expect(isSessionAmendable(null)).toBe(true);
    expect(isSessionAmendable(undefined)).toBe(true);
  });

  it("allows amendments within the default 24h window after endedAt", () => {
    const now = new Date("2026-05-06T10:00:00.000Z");
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const twentyThreeHoursAgo = new Date(now.getTime() - 23 * 60 * 60 * 1000);
    expect(isSessionAmendable(oneHourAgo, now)).toBe(true);
    expect(isSessionAmendable(twentyThreeHoursAgo, now)).toBe(true);
  });

  it("rejects amendments after the default 24h window", () => {
    const now = new Date("2026-05-06T10:00:00.000Z");
    const twentyFiveHoursAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(isSessionAmendable(twentyFiveHoursAgo, now)).toBe(false);
    expect(isSessionAmendable(oneWeekAgo, now)).toBe(false);
  });

  it("honors OPENBRIEFING_SESSION_AMEND_WINDOW_MS for a custom window", () => {
    const now = new Date("2026-05-06T10:00:00.000Z");
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
    process.env.OPENBRIEFING_SESSION_AMEND_WINDOW_MS = String(7 * 60 * 1000);
    // Window of 7 minutes: 5min ago is amendable, 10min ago is not.
    expect(isSessionAmendable(fiveMinutesAgo, now)).toBe(true);
    expect(isSessionAmendable(tenMinutesAgo, now)).toBe(false);
  });

  it("disables soft-end when OPENBRIEFING_SESSION_AMEND_WINDOW_MS=0", () => {
    process.env.OPENBRIEFING_SESSION_AMEND_WINDOW_MS = "0";
    const now = new Date("2026-05-06T10:00:00.000Z");
    const oneSecondAgo = new Date(now.getTime() - 1000);
    expect(isSessionAmendable(oneSecondAgo, now)).toBe(false);
  });

  it("falls back to the default window when the env var is malformed", () => {
    process.env.OPENBRIEFING_SESSION_AMEND_WINDOW_MS = "not-a-number";
    const now = new Date("2026-05-06T10:00:00.000Z");
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    expect(isSessionAmendable(oneHourAgo, now)).toBe(true);
  });
});
