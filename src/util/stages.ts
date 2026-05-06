/**
 * Stage runner: structured timing + per-stage timeouts for long pipelines.
 *
 * Designed for tools like `classify_discord_messages` that string together
 * many independently-failing async operations (GitHub sync, OpenAI
 * embeddings, Discord paginated fetches, large DB queries). Without explicit
 * staging, a hang inside any one of those calls becomes a silent multi-minute
 * MCP-client hang with no diagnostic output.
 *
 * Usage:
 *
 *   const issues = await runStage("issues:db-load", () => loadIssues(), {
 *     timeoutMs: 10_000,
 *     fallback: [],          // optional — if set, timeouts/errors RESOLVE with this value
 *     critical: false,       // optional — when true, errors propagate instead of falling back
 *   });
 *
 * Stage logs go to `console.error` (stderr is the MCP-safe channel) and look
 * like:
 *
 *   [stage] issues:db-load → start
 *   [stage] issues:db-load ← ok in 412ms
 *   [stage] github:sync ✕ TIMEOUT after 60000ms (using fallback)
 */

const DEFAULT_TIMEOUT_MS = 60_000;

export interface RunStageOptions<T> {
  /** Per-stage timeout in ms. Defaults to 60s. */
  timeoutMs?: number;
  /**
   * Value to resolve with on timeout / error. When provided, the stage is
   * non-fatal and the pipeline continues with this value. When omitted, the
   * stage rejects on timeout/error (use {@link RunStageOptions.critical} to
   * make this explicit at the call site).
   */
  fallback?: T;
  /**
   * When `true`, errors and timeouts always propagate even if `fallback` is
   * set. Useful for safety checks ("DB really must be reachable").
   */
  critical?: boolean;
  /**
   * Optional label printed alongside elapsed time, e.g. `"loaded 14 messages"`.
   */
  detail?: () => string;
}

/**
 * Wrap an async operation with structured logging + a per-stage timeout.
 *
 * On timeout (or error) when a `fallback` is configured and `critical` is
 * not set, the stage logs a warning and resolves with the fallback so the
 * pipeline can continue.
 */
export async function runStage<T>(
  name: string,
  fn: () => Promise<T>,
  options: RunStageOptions<T> = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  console.error(`[stage] ${name} → start (timeout ${timeoutMs}ms)`);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`stage "${name}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timeoutHandle === "object" && timeoutHandle && "unref" in timeoutHandle) {
      (timeoutHandle as unknown as { unref?: () => void }).unref?.();
    }
  });

  try {
    const result = await Promise.race([fn(), timeout]);
    const elapsed = Date.now() - start;
    const detail = options.detail ? ` ${options.detail()}` : "";
    console.error(`[stage] ${name} ← ok in ${elapsed}ms${detail}`);
    return result;
  } catch (err) {
    const elapsed = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes("timed out");
    const tag = isTimeout ? "TIMEOUT" : "ERROR";

    if (options.fallback !== undefined && !options.critical) {
      console.error(
        `[stage] ${name} ✕ ${tag} after ${elapsed}ms (using fallback): ${message}`,
      );
      return options.fallback;
    }

    console.error(`[stage] ${name} ✕ ${tag} after ${elapsed}ms: ${message}`);
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Read a numeric env var, falling back to a default. Negative or non-numeric
 * values fall back. Use this for tool-level timeout overrides.
 */
export function readTimeoutEnv(envKey: string, defaultMs: number): number {
  const raw = process.env[envKey];
  if (!raw) return defaultMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `[stage] ${envKey}=${raw} is not a positive number; using default ${defaultMs}ms`,
    );
    return defaultMs;
  }
  return parsed;
}

/**
 * Race a long-running operation against a hard overall ceiling. Used at the
 * top of MCP tool handlers so a stuck pipeline can never silently exceed the
 * MCP client's expectations.
 */
export async function withOverallTimeout<T>(
  name: string,
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      reject(
        new Error(
          `${name} exceeded overall timeout of ${timeoutMs}ms — see [stage] logs above for the slow step.`,
        ),
      );
    }, timeoutMs);
    if (typeof handle === "object" && handle && "unref" in handle) {
      (handle as unknown as { unref?: () => void }).unref?.();
    }
  });

  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}
