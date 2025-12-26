/**
 * Discord-specific configuration
 */
export interface DiscordConfig {
  serverId?: string;
  defaultChannelId?: string;
  channelNames?: {
    development?: string;
    general?: string;
    chat?: string;
  };
}

export function getDiscordConfig(): DiscordConfig {
  return {
    serverId: process.env.DISCORD_SERVER_ID,
    defaultChannelId: process.env.DISCORD_DEFAULT_CHANNEL_ID,
    channelNames: {
      development: process.env.DISCORD_CHANNEL_DEVELOPMENT || "development",
      general: process.env.DISCORD_CHANNEL_GENERAL || "general",
      chat: process.env.DISCORD_CHANNEL_CHAT || "chat",
    },
  };
}

