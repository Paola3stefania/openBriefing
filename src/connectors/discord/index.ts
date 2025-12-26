/**
 * Discord connector exports
 * Note: Discord cache types are exported from storage/cache
 */
export * from "./adapter.js";

// Re-export DiscordMessage type from cache for convenience
export type { DiscordMessage, DiscordCache, ThreadMessages } from "../../storage/cache/discordCache.js";

