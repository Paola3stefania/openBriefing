import { describe, expect, it } from "vitest";
import { toStorageMessage } from "./ingest.js";

const baseInput = {
  source: "slack",
  workspaceId: "T01ABC",
  workspaceName: "Acme",
  channelId: "C123",
  channelName: "general",
  messages: [],
};

describe("toStorageMessage", () => {
  it("prefixes channel + message + workspace IDs with `<source>:<workspaceId>:...`", () => {
    const row = toStorageMessage(baseInput, {
      id: "msg-1",
      authorId: "U1",
      authorName: "alice",
      content: "hello",
      createdAt: "2026-04-27T12:00:00Z",
    });

    expect(row.id).toBe("slack:T01ABC:C123:msg-1");
    expect(row.channelId).toBe("slack:T01ABC:C123");
    expect(row.guildId).toBe("slack:T01ABC");
    expect(row.guildName).toBe("Acme");
    expect(row.channelName).toBe("general");
    expect(row.timestamp).toBe(row.createdAt);
  });

  it("lowercases the source and rejects illegal source characters", () => {
    expect(
      toStorageMessage({ ...baseInput, source: "Slack" }, {
        id: "x",
        authorId: "u",
        content: "",
        createdAt: "2026-04-27T12:00:00Z",
      }).guildId,
    ).toBe("slack:T01ABC");

    expect(() =>
      toStorageMessage({ ...baseInput, source: "bad source!" }, {
        id: "x",
        authorId: "u",
        content: "",
        createdAt: "2026-04-27T12:00:00Z",
      }),
    ).toThrow(/`source` must match/);
  });

  it("prefixes thread + reply IDs so cross-source references stay namespaced", () => {
    const row = toStorageMessage(baseInput, {
      id: "msg-2",
      authorId: "U1",
      content: "reply",
      createdAt: "2026-04-27T12:01:00Z",
      threadId: "msg-1",
      replyTo: "msg-1",
    });

    expect(row.threadId).toBe("slack:T01ABC:C123:msg-1");
    expect(row.messageReference).toEqual({
      message_id: "slack:T01ABC:C123:msg-1",
      channel_id: "slack:T01ABC:C123",
      guild_id: "slack:T01ABC",
    });
  });

  it("normalizes attachments and reactions", () => {
    const row = toStorageMessage(baseInput, {
      id: "msg-3",
      authorId: "U1",
      content: "with files",
      createdAt: "2026-04-27T12:02:00Z",
      attachments: [
        { id: "f1", filename: "x.png", url: "https://x", size: 42, contentType: "image/png" },
      ],
      reactions: [{ emoji: "+1", count: 2 }],
      mentions: ["U2"],
    });

    expect(row.attachments).toEqual([
      { id: "f1", filename: "x.png", url: "https://x", size: 42, content_type: "image/png" },
    ]);
    expect(row.reactions).toEqual([{ emoji: "+1", count: 2 }]);
    expect(row.mentions).toEqual(["U2"]);
  });

  it("requires source, workspaceId, channelId, and message id", () => {
    expect(() =>
      toStorageMessage({ ...baseInput, source: "" }, {
        id: "x",
        authorId: "u",
        content: "",
        createdAt: "2026-04-27T12:00:00Z",
      }),
    ).toThrow(/`source` is required/);
    expect(() =>
      toStorageMessage({ ...baseInput, workspaceId: "" }, {
        id: "x",
        authorId: "u",
        content: "",
        createdAt: "2026-04-27T12:00:00Z",
      }),
    ).toThrow(/`workspaceId` is required/);
    expect(() =>
      toStorageMessage(baseInput, {
        id: "",
        authorId: "u",
        content: "",
        createdAt: "2026-04-27T12:00:00Z",
      }),
    ).toThrow(/`message.id` is required/);
  });
});
