/**
 * Adapter to convert DiscordMessage to Signal
 */
import type { DiscordMessage as CachedDiscordMessage } from "../../storage/cache/discordCache.js";
import type { Signal } from "../../types/signal.js";

export function discordMessageToSignal(message: CachedDiscordMessage): Signal {
  // Build Discord message URL
  const permalink = message.url || 
    (message.guild_id && message.channel_id
      ? `https://discord.com/channels/${message.guild_id}/${message.channel_id}/${message.id}`
      : message.id);

  return {
    source: "discord",
    sourceId: message.id,
    permalink,
    title: message.thread?.name,
    body: message.content || "",
    createdAt: message.created_at || message.timestamp,
    updatedAt: message.edited_at || undefined,
    metadata: {
      author: message.author,
      channel_id: message.channel_id,
      channel_name: message.channel_name,
      guild_id: message.guild_id,
      guild_name: message.guild_name,
      thread_id: message.thread?.id,
      thread_name: message.thread?.name,
      attachments: message.attachments,
      mentions: message.mentions,
      reactions: message.reactions,
      message_reference: message.message_reference,
    },
  };
}

export function discordMessagesToSignals(messages: CachedDiscordMessage[]): Signal[] {
  return messages.map(discordMessageToSignal);
}

