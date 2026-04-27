#!/usr/bin/env npx tsx
/**
 * Sync GitHub issues and Discord messages into the database — same data path as
 * MCP `fetch_github_issues` + `fetch_discord_messages` with DATABASE_URL set.
 *
 * Usage:
 *   npm run sync:all
 *   npm run sync:all -- --full
 *   npm run sync:all -- --github-only
 *   npm run sync:all -- --discord-only
 *   npm run sync:all -- --channel <channel_id>
 *   npm run sync:all -- --repo owner/repo
 */
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  DMChannel,
  NewsChannel,
  Message,
} from "discord.js";
import { getConfig } from "../src/config/index.js";
import { fetchAllGitHubIssues } from "../src/connectors/github/client.js";
import { GitHubTokenManager } from "../src/connectors/github/tokenManager.js";

const args = process.argv.slice(2);

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function getVal(flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

async function main(): Promise<void> {
  const config = getConfig();
  const githubOnly = hasFlag("--github-only");
  const discordOnly = hasFlag("--discord-only");
  if (githubOnly && discordOnly) {
    throw new Error("Use only one of --github-only or --discord-only");
  }

  const full = hasFlag("--full");
  const incremental = !full;

  const { hasDatabaseConfig, getStorage } = await import("../src/storage/factory.js");
  if (!hasDatabaseConfig()) {
    throw new Error("DATABASE_URL is required. This script syncs into the database like the MCP tools.");
  }
  const storage = getStorage();
  if (!(await storage.isAvailable())) {
    throw new Error("Database is not available. Check DATABASE_URL and connectivity.");
  }

  const out: { github?: unknown; discord?: unknown } = {};

  if (!discordOnly) {
    out.github = await syncGitHubToDb({
      incremental,
      owner: config.github.owner,
      repo: config.github.repo,
      repoOverride: getVal("--repo"),
    });
  }

  if (!githubOnly) {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      throw new Error("DISCORD_TOKEN is required for Discord sync");
    }
    const channelId =
      getVal("--channel") || config.discord.defaultChannelId;
    if (!channelId) {
      throw new Error(
        "Set DISCORD_DEFAULT_CHANNEL_ID in .env or pass --channel <id>",
      );
    }
    const limitStr = getVal("--limit");
    out.discord = await syncDiscordToDb({
      token,
      channelId,
      incremental,
      limit: limitStr ? parseInt(limitStr, 10) : undefined,
    });
  }

  console.log(JSON.stringify({ success: true, ...out }, null, 2));
}

async function syncGitHubToDb(options: {
  incremental: boolean;
  owner: string;
  repo: string;
  repoOverride?: string;
}): Promise<Record<string, unknown>> {
  const { incremental } = options;
  let owner = options.owner;
  let repo = options.repo;
  if (options.repoOverride) {
    const parts = options.repoOverride.split("/");
    if (parts.length !== 2) {
      throw new Error(`Invalid --repo value "${options.repoOverride}" (expected owner/repo)`);
    }
    [owner, repo] = [parts[0]!, parts[1]!];
  }
  if (!owner || !repo) {
    throw new Error("Set GITHUB_OWNER and GITHUB_REPO, or use --repo owner/repo");
  }

  const { prisma } = await import("../src/storage/db/prisma.js");
  const { getStorage } = await import("../src/storage/factory.js");
  const storage = getStorage();

  let sinceDate: string | undefined;
  if (incremental) {
    const last = await prisma.gitHubIssue.findFirst({
      orderBy: { issueUpdatedAt: "desc" },
      select: { issueUpdatedAt: true },
    });
    if (last?.issueUpdatedAt) {
      sinceDate = last.issueUpdatedAt.toISOString();
    }
  }

  const tokenManager = await GitHubTokenManager.fromEnvironment();
  if (!tokenManager) {
    throw new Error("GITHUB_TOKEN or GitHub App env vars are required for GitHub sync");
  }

  const repoParam = options.repoOverride ? options.repoOverride : undefined;
  const newIssues = await fetchAllGitHubIssues(
    tokenManager,
    true,
    owner,
    repo,
    sinceDate,
    undefined,
    true,
  );

  if (newIssues.length > 0) {
    const issuesToSave = newIssues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      state: issue.state,
      body: issue.body || undefined,
      labels: issue.labels.map((l) => l.name),
      author: issue.user.login,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      comments: issue.comments || [],
      assignees: issue.assignees || [],
      milestone: issue.milestone || null,
      reactions: issue.reactions || null,
    }));
    await storage.saveGitHubIssues(issuesToSave, repoParam);
  }

  const total = await prisma.gitHubIssue.count();
  const open = await prisma.gitHubIssue.count({ where: { issueState: "open" } });

  console.error(
    `[sync] GitHub: new/updated rows ${newIssues.length} (mode: ${incremental ? "incremental" : "full"}). DB total=${total} open=${open}`,
  );

  return {
    new_or_updated: newIssues.length,
    total_in_db: total,
    open_in_db: open,
    mode: incremental ? "incremental" : "full",
  };
}

async function syncDiscordToDb(options: {
  token: string;
  channelId: string;
  incremental: boolean;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const { token, channelId, incremental, limit: maxMessages } = options;
  const { getStorage } = await import("../src/storage/factory.js");
  const storage = getStorage();

  let sinceDate: string | undefined;
  if (incremental) {
    sinceDate = (await storage.getMostRecentDiscordMessageDate(channelId)) || undefined;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  await client.login(token);

  try {
    const channel = await client.channels.fetch(channelId);
    if (
      !channel ||
      (!(channel instanceof TextChannel) &&
        !(channel instanceof DMChannel) &&
        !(channel instanceof NewsChannel))
    ) {
      throw new Error("Channel does not support message fetch or was not found");
    }

    const channelName =
      channel instanceof TextChannel || channel instanceof NewsChannel
        ? `#${channel.name}`
        : "DM";
    const guildId =
      channel instanceof TextChannel || channel instanceof NewsChannel
        ? channel.guild?.id
        : undefined;

    let fetchedMessages: Message[] = [];
    let lastMessageId: string | undefined;
    let hasMore = true;

    while (hasMore && (maxMessages === undefined || fetchedMessages.length < maxMessages)) {
      const options: { limit: number; before?: string } = { limit: 100 };
      if (lastMessageId) options.before = lastMessageId;

      const messages = await channel.messages.fetch(options);
      if (messages.size === 0) {
        hasMore = false;
        break;
      }
      const messageArray = Array.from(messages.values()) as Message[];

      if (incremental && sinceDate) {
        const sinceTime = new Date(sinceDate).getTime();
        const newMessages = messageArray.filter((msg) => {
          const createdTime = msg.createdAt.getTime();
          const editedTime = msg.editedAt ? msg.editedAt.getTime() : 0;
          return createdTime >= sinceTime || editedTime >= sinceTime;
        });
        if (newMessages.length === 0) {
          const newestInBatch = messageArray[0]!;
          const newestTime = Math.max(
            newestInBatch.createdAt.getTime(),
            newestInBatch.editedAt ? newestInBatch.editedAt.getTime() : 0,
          );
          if (newestTime < sinceTime) {
            hasMore = false;
            break;
          }
        }
        fetchedMessages.push(...newMessages);
      } else {
        fetchedMessages.push(...messageArray);
      }

      lastMessageId = messageArray[messageArray.length - 1]!.id;
      if (messages.size < 100) hasMore = false;
    }

    const flat = fetchedMessages.map((msg) => {
      const f = formatDiscordForDb(msg, channel, channelId, channelName, guildId);
      return {
        id: f.id,
        channelId: f.channel_id,
        authorId: f.author.id,
        authorUsername: f.author.username,
        authorDiscriminator: f.author.discriminator,
        authorBot: f.author.bot,
        authorAvatar: f.author.avatar ?? undefined,
        content: f.content,
        createdAt: f.created_at,
        editedAt: f.edited_at ?? undefined,
        timestamp: f.timestamp,
        channelName: f.channel_name,
        guildId: f.guild_id,
        guildName: f.guild_name,
        attachments: f.attachments,
        embeds: f.embeds,
        mentions: f.mentions,
        reactions: f.reactions,
        threadId: f.thread?.id,
        threadName: f.thread?.name,
        messageReference: f.message_reference ?? undefined,
        url: f.url,
      };
    });
    if (flat.length > 0) {
      await storage.upsertChannel(channelId, channelName, guildId);
      await storage.saveDiscordMessages(flat);
    }

    console.error(
      `[sync] Discord: ${flat.length} messages (mode: ${incremental ? "incremental" : "full"}) for channel ${channelName}`,
    );

    return {
      channel_id: channelId,
      messages_upserted: flat.length,
      mode: incremental ? "incremental" : "full",
    };
  } finally {
    await client.destroy();
  }
}

function formatDiscordForDb(
  msg: Message,
  channel: TextChannel | DMChannel | NewsChannel,
  actualChannelId: string,
  channelName: string,
  guildId: string | undefined,
) {
  return {
    id: msg.id,
    author: {
      id: msg.author.id,
      username: msg.author.username,
      discriminator: msg.author.discriminator,
      bot: msg.author.bot,
      avatar: msg.author.avatar,
    },
    content: msg.content,
    created_at: msg.createdAt.toISOString(),
    edited_at: msg.editedAt ? msg.editedAt.toISOString() : null,
    timestamp: msg.createdTimestamp.toString(),
    channel_id: actualChannelId,
    channel_name: channelName,
    guild_id: guildId,
    guild_name:
      channel instanceof TextChannel || channel instanceof NewsChannel
        ? channel.guild?.name
        : undefined,
    attachments: Array.from(msg.attachments.values()).map((att) => ({
      id: att.id,
      filename: att.name,
      url: att.url,
      size: att.size,
      content_type: att.contentType || undefined,
    })),
    embeds: msg.embeds.length,
    mentions: Array.from(msg.mentions.users.keys()).map((id) => String(id)),
    reactions: Array.from(msg.reactions.cache.values()).map((reaction) => ({
      emoji: reaction.emoji.name || String(reaction.emoji.id || ""),
      count: reaction.count,
    })),
    thread: msg.thread
      ? { id: msg.thread.id, name: msg.thread.name }
      : undefined,
    message_reference: msg.reference
      ? {
          message_id: msg.reference.messageId || "",
          channel_id: msg.reference.channelId || "",
          guild_id: msg.reference.guildId || undefined,
        }
      : undefined,
    url: msg.url,
  };
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
