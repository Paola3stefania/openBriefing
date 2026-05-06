/**
 * Per-project scoping for shared databases.
 *
 * OpenRundown is often run with a single Postgres database serving multiple
 * projects (different repos, same DB). Chat-derived data (`Group`,
 * `ClassifiedThread`, `UngroupedThread`, raw `DiscordMessage` rows used as a
 * generic chat-message store) and X/Twitter posts are not keyed by `projectId`
 * in the schema, so without a scoping rule a briefing for project A will
 * surface signals from project B's ingest.
 *
 * This module reads env-var-driven mappings that let the operator say
 * "project X owns chat workspaces Y and Z" without a schema migration. The
 * helper is **source-agnostic**: any MCP that ingests chat-like data into the
 * generic `Channel` + `DiscordMessage` tables (Discord, Slack, Microsoft
 * Teams, Telegram, Matrix, custom forums, ...) can plug in by writing a
 * stable `Channel.guildId` value and adding it to `PROJECT_CHAT_WORKSPACES`.
 *
 * Two env vars are honored:
 *
 *   - `PROJECT_CHAT_WORKSPACES` (preferred, generic):
 *       JSON object mapping `projectId -> string[]`, where each string is a
 *       fully-qualified workspace identifier matching `Channel.guildId`. By
 *       convention, IDs from non-Discord sources should be prefixed with the
 *       source name to avoid collisions, e.g.
 *         `"owner/repo": ["discord:1288...", "slack:T01ABC", "teams:tenant-x"]`.
 *
 *   - `PROJECT_DISCORD_GUILDS` (legacy, Discord-only):
 *       Same JSON shape, but values are bare Discord guild IDs (no prefix).
 *       Honored as-is for backward compatibility with existing deployments
 *       and stored Discord rows whose `guildId` is the bare snowflake.
 *
 * Backward compatibility: when **neither** env var is set, the legacy
 * behavior (no filter) is preserved so single-project setups don't change.
 */

const ENV_KEY_DISCORD = "PROJECT_DISCORD_GUILDS";
const ENV_KEY_CHAT = "PROJECT_CHAT_WORKSPACES";

interface CachedMap {
  raw: string;
  map: Map<string, string[]>;
}

let cacheDiscord: CachedMap | undefined;
let cacheChat: CachedMap | undefined;

function loadMap(envKey: string, current: CachedMap | undefined): {
  cache: CachedMap | undefined;
  map: Map<string, string[]> | undefined;
} {
  const raw = process.env[envKey];
  if (!raw) {
    return { cache: undefined, map: undefined };
  }

  if (current && raw === current.raw) {
    return { cache: current, map: current.map };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`[projectScope] ${envKey} must be a JSON object mapping projectId -> string[].`);
      const empty: CachedMap = { raw, map: new Map() };
      return { cache: empty, map: empty.map };
    }

    const map = new Map<string, string[]>();
    for (const [projectId, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(ids)) {
        console.error(`[projectScope] ${envKey}["${projectId}"] is not an array; ignoring.`);
        continue;
      }
      const cleaned = ids.filter(
        (g): g is string => typeof g === "string" && g.trim().length > 0,
      );
      map.set(projectId, cleaned);
    }
    const cache: CachedMap = { raw, map };
    return { cache, map };
  } catch (error) {
    console.error(`[projectScope] Failed to parse ${envKey}: ${(error as Error).message}`);
    const empty: CachedMap = { raw, map: new Map() };
    return { cache: empty, map: empty.map };
  }
}

function loadDiscord(): Map<string, string[]> | undefined {
  const { cache, map } = loadMap(ENV_KEY_DISCORD, cacheDiscord);
  cacheDiscord = cache;
  return map;
}

function loadChat(): Map<string, string[]> | undefined {
  const { cache, map } = loadMap(ENV_KEY_CHAT, cacheChat);
  cacheChat = cache;
  return map;
}

/**
 * Returns the Discord guild IDs that should scope a briefing for `projectId`.
 *
 * Reads `PROJECT_DISCORD_GUILDS` only. Kept for backward compatibility with
 * existing call sites and tests; new code should prefer
 * {@link getProjectChatWorkspaceIds}.
 *
 * Return value semantics:
 *   - `undefined`     → no mapping configured; caller should not filter.
 *   - `string[]` (>=0) → caller MUST filter Discord queries to those guilds.
 *                       An empty array means "this project owns no Discord
 *                       data; suppress Discord-derived signals entirely."
 */
export function getProjectDiscordGuilds(projectId: string): string[] | undefined {
  const map = loadDiscord();
  if (!map) return undefined;
  return map.get(projectId) ?? [];
}

/**
 * Returns the chat workspace IDs (matching `Channel.guildId`) that should
 * scope a briefing for `projectId`, across **all** chat sources (Discord,
 * Slack, Teams, Telegram, custom MCPs, ...).
 *
 * Combines the legacy `PROJECT_DISCORD_GUILDS` map with the generic
 * `PROJECT_CHAT_WORKSPACES` map. By convention, non-Discord sources should
 * use prefixed IDs (e.g. `slack:T01ABC123`); the same prefix should be used
 * by ingest code when writing `Channel.guildId`.
 *
 * Return value semantics:
 *   - `undefined`     → neither env var configured; caller should not filter
 *                       (preserves single-project / pre-migration behavior).
 *   - `string[]` (>=0) → caller MUST filter chat-derived queries to these
 *                       workspace IDs. An empty array means "this project
 *                       owns no chat data; suppress chat-derived signals."
 */
export function getProjectChatWorkspaceIds(projectId: string): string[] | undefined {
  const discord = loadDiscord();
  const chat = loadChat();

  if (!discord && !chat) return undefined;

  const ids = new Set<string>();
  if (discord) {
    for (const id of discord.get(projectId) ?? []) ids.add(id);
  }
  if (chat) {
    for (const id of chat.get(projectId) ?? []) ids.add(id);
  }
  return [...ids];
}

/**
 * Test-only helper to reset the cache between cases that mutate `process.env`.
 */
export function __resetProjectScopeCacheForTests(): void {
  cacheDiscord = undefined;
  cacheChat = undefined;
}
