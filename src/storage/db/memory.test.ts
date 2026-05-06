/**
 * Pure-function tests for the memory helpers. The DB-touching paths (saveMemory,
 * searchMemory, ...) are integration concerns; here we cover the shape-prep
 * for `saveSessionInsights` so the tag layout and filtering rules are locked
 * in without depending on Prisma.
 */

import { describe, expect, it } from "vitest";
import { prepareSessionInsights } from "./memory.js";

describe("prepareSessionInsights", () => {
  it("returns an empty array when there are no insights", () => {
    expect(prepareSessionInsights("s1", [])).toEqual([]);
  });

  it("filters non-strings, empty strings, and whitespace-only entries", () => {
    const result = prepareSessionInsights("s1", [
      "real one",
      "",
      "   ",
      undefined,
      null,
      42,
      "another real one",
    ]);
    expect(result.map((r) => r.content)).toEqual(["real one", "another real one"]);
  });

  it("tags every entry with 'session' and 'session:<id>' plus any extra tags", () => {
    const result = prepareSessionInsights("abc-123", ["pick stripe over braintree"], [
      "billing",
      "decision",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].tags).toEqual(["session", "session:abc-123", "billing", "decision"]);
  });

  it("auto-summarizes long content with an ellipsis at <=240 chars", () => {
    const long = "x".repeat(500);
    const [item] = prepareSessionInsights("s1", [long]);
    expect(item.content).toBe(long);
    expect(item.summary.length).toBeLessThanOrEqual(240);
    expect(item.summary.endsWith("…")).toBe(true);
  });

  it("uses content directly as summary when short enough", () => {
    const short = "we picked Postgres for the audit log because of pgvector";
    const [item] = prepareSessionInsights("s1", [short]);
    expect(item.summary).toBe(short);
    expect(item.summary.endsWith("…")).toBe(false);
  });

  it("trims surrounding whitespace from real entries before storing", () => {
    const [item] = prepareSessionInsights("s1", ["   real insight   "]);
    expect(item.content).toBe("real insight");
    expect(item.summary).toBe("real insight");
  });
});
