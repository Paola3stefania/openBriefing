/**
 * Generic chat ingest pipeline.
 *
 * OpenRundown's `Channel` + `DiscordMessage` tables were originally built for
 * Discord, but their schema is generic enough to store any chat-like data:
 * channel + author + content + timestamps + (optional) thread + attachments.
 *
 * This module lets **any** MCP that extracts chat data (Slack, Microsoft
 * Teams, Telegram, Matrix, Mattermost, Zulip, custom forums, ...) hand off
 * normalized messages to OpenRundown for storage. The data then flows through
 * the same downstream classification, grouping, embedding, and briefing
 * pipelines as native Discord ingest — agents can `get_agent_briefing` and
 * see signals from every chat source for the project.
 *
 * Design choices:
 *
 *   1. Fully **source-agnostic**: the caller passes a free-form `source`
 *      string ("slack", "teams", "telegram", or anything else). We don't
 *      enforce a closed enum — new MCPs shouldn't require a schema change.
 *
 *   2. **Prefixed IDs** to avoid collisions in a shared database:
 *        - `Channel.guildId`   = `${source}:${workspaceId}`
 *        - `Channel.id`        = `${source}:${workspaceId}:${channelId}`
 *        - `DiscordMessage.id` = `${source}:${workspaceId}:${channelId}:${messageId}`
 *      The `Channel.guildId` value is exactly what
 *      `PROJECT_CHAT_WORKSPACES` should list for project scoping, so a
 *      briefing for project A only surfaces project A's chat signals.
 *
 *   3. **Idempotent**: re-ingesting the same messages is a no-op (uses
 *      `saveDiscordMessages`'s upsert semantics).
 *
 *   4. Discord-specific fields (`discriminator`, `embeds`, ...) are left
 *      blank/zero for non-Discord sources; downstream consumers tolerate
 *      missing values.
 */

import { getStorage, hasDatabaseConfig } from "../storage/factory.js";

export interface NormalizedChatAttachment {
  id: string;
  filename: string;
  url: string;
  size?: number;
  contentType?: string;
}

export interface NormalizedChatReaction {
  emoji: string;
  count: number;
}

export interface NormalizedChatMessage {
  /** Native message ID from the source (will be prefixed for storage). */
  id: string;
  authorId: string;
  authorName?: string;
  authorIsBot?: boolean;
  authorAvatar?: string;
  content: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp; null/undefined if never edited. */
  editedAt?: string | null;
  /** Native thread/parent message ID, if this message is in a thread. */
  threadId?: string;
  threadName?: string;
  /** Native ID of the message this is a reply to, if any. */
  replyTo?: string;
  attachments?: NormalizedChatAttachment[];
  mentions?: string[];
  reactions?: NormalizedChatReaction[];
  /** Optional permalink back to the source. */
  url?: string;
}

export interface IngestChatMessagesInput {
  /** Free-form source identifier ("slack", "teams", "telegram", ...). */
  source: string;
  /** Workspace / team / tenant ID at the source. */
  workspaceId: string;
  workspaceName?: string;
  channelId: string;
  channelName?: string;
  messages: NormalizedChatMessage[];
}

export interface IngestChatMessagesResult {
  source: string;
  workspaceKey: string;
  channelKey: string;
  inserted: number;
  skipped: number;
  errors: string[];
}

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function normalizeSource(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error("ingest_chat_messages: `source` is required.");
  }
  if (!SOURCE_PATTERN.test(trimmed)) {
    throw new Error(
      `ingest_chat_messages: \`source\` must match ${SOURCE_PATTERN}; got "${source}".`,
    );
  }
  return trimmed.toLowerCase();
}

function nonEmpty(label: string, value: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`ingest_chat_messages: \`${label}\` is required.`);
  return trimmed;
}

function workspaceKey(source: string, workspaceId: string): string {
  return `${source}:${workspaceId}`;
}

function channelKey(source: string, workspaceId: string, channelId: string): string {
  return `${source}:${workspaceId}:${channelId}`;
}

function messageKey(
  source: string,
  workspaceId: string,
  channelId: string,
  messageId: string,
): string {
  return `${source}:${workspaceId}:${channelId}:${messageId}`;
}

/**
 * Normalize one message into the shape expected by `saveDiscordMessages`.
 * Exported for tests; callers should use {@link ingestChatMessages}.
 */
export function toStorageMessage(
  input: IngestChatMessagesInput,
  msg: NormalizedChatMessage,
): {
  id: string;
  channelId: string;
  authorId: string;
  authorUsername?: string;
  authorBot?: boolean;
  authorAvatar?: string;
  content: string;
  createdAt: string;
  editedAt?: string | null;
  timestamp: string;
  channelName?: string;
  guildId?: string;
  guildName?: string;
  attachments?: Array<{
    id: string;
    filename: string;
    url: string;
    size: number;
    content_type?: string;
  }>;
  embeds?: number;
  mentions?: string[];
  reactions?: Array<{ emoji: string; count: number }>;
  threadId?: string;
  threadName?: string;
  messageReference?: { message_id: string; channel_id: string; guild_id?: string } | null;
  url?: string;
} {
  const source = normalizeSource(input.source);
  const workspaceId = nonEmpty("workspaceId", input.workspaceId);
  const channelId = nonEmpty("channelId", input.channelId);
  const ws = workspaceKey(source, workspaceId);
  const ch = channelKey(source, workspaceId, channelId);

  return {
    id: messageKey(source, workspaceId, channelId, nonEmpty("message.id", msg.id)),
    channelId: ch,
    authorId: msg.authorId ?? "unknown",
    authorUsername: msg.authorName,
    authorBot: msg.authorIsBot,
    authorAvatar: msg.authorAvatar,
    content: msg.content ?? "",
    createdAt: msg.createdAt,
    editedAt: msg.editedAt ?? null,
    timestamp: msg.createdAt,
    channelName: input.channelName,
    guildId: ws,
    guildName: input.workspaceName,
    attachments: msg.attachments?.map((a) => ({
      id: a.id,
      filename: a.filename,
      url: a.url,
      size: a.size ?? 0,
      content_type: a.contentType,
    })),
    embeds: 0,
    mentions: msg.mentions,
    reactions: msg.reactions,
    threadId: msg.threadId
      ? messageKey(source, workspaceId, channelId, msg.threadId)
      : undefined,
    threadName: msg.threadName,
    messageReference: msg.replyTo
      ? {
          message_id: messageKey(source, workspaceId, channelId, msg.replyTo),
          channel_id: ch,
          guild_id: ws,
        }
      : null,
    url: msg.url,
  };
}

/**
 * Persist a batch of normalized chat messages from any external MCP into the
 * generic chat storage. Returns counts and the prefixed keys callers can put
 * into `PROJECT_CHAT_WORKSPACES` for project scoping.
 */
export async function ingestChatMessages(
  input: IngestChatMessagesInput,
): Promise<IngestChatMessagesResult> {
  if (!hasDatabaseConfig()) {
    throw new Error(
      "ingest_chat_messages: a database (DATABASE_URL) is required to persist external chat messages.",
    );
  }

  const source = normalizeSource(input.source);
  const workspaceId = nonEmpty("workspaceId", input.workspaceId);
  const channelId = nonEmpty("channelId", input.channelId);
  const ws = workspaceKey(source, workspaceId);
  const ch = channelKey(source, workspaceId, channelId);

  if (!Array.isArray(input.messages)) {
    throw new Error("ingest_chat_messages: `messages` must be an array.");
  }

  const storage = getStorage();
  await storage.upsertChannel(ch, input.channelName, ws);

  const errors: string[] = [];
  const rows: ReturnType<typeof toStorageMessage>[] = [];
  for (const msg of input.messages) {
    try {
      rows.push(toStorageMessage(input, msg));
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  if (rows.length > 0) {
    await storage.saveDiscordMessages(rows);
  }

  return {
    source,
    workspaceKey: ws,
    channelKey: ch,
    inserted: rows.length,
    skipped: input.messages.length - rows.length,
    errors,
  };
}
