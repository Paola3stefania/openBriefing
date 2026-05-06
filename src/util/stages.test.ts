import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTimeoutEnv, runStage, withOverallTimeout } from "./stages.js";

describe("runStage", () => {
  const originalErr = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });
  afterEach(() => {
    console.error = originalErr;
  });

  it("returns the resolved value and logs ok with elapsed time", async () => {
    const result = await runStage("test:fast", async () => "hello", {
      timeoutMs: 1000,
    });
    expect(result).toBe("hello");
    const calls = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).includes("→ start"))).toBe(true);
    expect(calls.some((c) => String(c[0]).includes("← ok"))).toBe(true);
  });

  it("uses the fallback on timeout when fallback is provided", async () => {
    const result = await runStage(
      "test:slow",
      () => new Promise<string>((resolve) => setTimeout(() => resolve("never"), 1000)),
      { timeoutMs: 25, fallback: "fb" },
    );
    expect(result).toBe("fb");
    const calls = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).includes("✕ TIMEOUT"))).toBe(true);
  });

  it("uses the fallback on error when fallback is provided", async () => {
    const result = await runStage(
      "test:err",
      async () => {
        throw new Error("boom");
      },
      { fallback: "ok" },
    );
    expect(result).toBe("ok");
    const calls = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).includes("✕ ERROR"))).toBe(true);
  });

  it("propagates errors when critical is true even if fallback is set", async () => {
    await expect(
      runStage(
        "test:critical",
        async () => {
          throw new Error("boom");
        },
        { fallback: "ignored", critical: true },
      ),
    ).rejects.toThrow("boom");
  });

  it("propagates timeouts when no fallback is configured", async () => {
    await expect(
      runStage(
        "test:hang",
        () => new Promise<string>(() => {/* hang */}),
        { timeoutMs: 25 },
      ),
    ).rejects.toThrow(/timed out/);
  });
});

describe("readTimeoutEnv", () => {
  const KEY = "__TEST_TIMEOUT__";
  const originalErr = console.error;
  beforeEach(() => {
    delete process.env[KEY];
    console.error = vi.fn();
  });
  afterEach(() => {
    delete process.env[KEY];
    console.error = originalErr;
  });

  it("returns the default when unset", () => {
    expect(readTimeoutEnv(KEY, 1234)).toBe(1234);
  });

  it("parses a positive integer", () => {
    process.env[KEY] = "9000";
    expect(readTimeoutEnv(KEY, 1234)).toBe(9000);
  });

  it("falls back on non-numeric values", () => {
    process.env[KEY] = "not-a-number";
    expect(readTimeoutEnv(KEY, 1234)).toBe(1234);
  });

  it("falls back on zero or negative", () => {
    process.env[KEY] = "0";
    expect(readTimeoutEnv(KEY, 1234)).toBe(1234);
    process.env[KEY] = "-100";
    expect(readTimeoutEnv(KEY, 1234)).toBe(1234);
  });
});

describe("withOverallTimeout", () => {
  it("resolves with the inner value when the inner finishes in time", async () => {
    const v = await withOverallTimeout("outer", async () => 42, 1000);
    expect(v).toBe(42);
  });

  it("rejects with a clear message on timeout", async () => {
    await expect(
      withOverallTimeout("outer", () => new Promise<number>(() => {/* hang */}), 25),
    ).rejects.toThrow(/exceeded overall timeout of 25ms/);
  });
});
