/**
 * Tool executor - thin wrapper that calls existing MCP tool logic
 * No duplication - just imports and calls the real implementations
 */
import "dotenv/config";
import type { Prisma } from "@prisma/client";

// Re-export tool list for API discovery
export const AVAILABLE_TOOLS = [
  { name: "list_servers", description: "List all Discord servers the bot has access to" },
  { name: "list_channels", description: "List all text channels in a Discord server" },
  { name: "read_messages", description: "Read recent messages from a Discord channel" },
  { name: "fetch_discord_messages", description: "Fetch and cache Discord messages (incremental)" },
  { name: "fetch_github_issues", description: "Fetch and cache GitHub issues (incremental)" },
  { name: "search_github_issues", description: "Search GitHub issues" },
  { name: "classify_discord_messages", description: "Classify Discord messages against GitHub issues" },
  { name: "group_github_issues", description: "Group related GitHub issues together" },
  { name: "match_issues_to_threads", description: "Match GitHub issues to Discord threads" },
  { name: "match_issues_to_features", description: "Match GitHub issues to product features" },
  { name: "label_github_issues", description: "Detect and assign labels to GitHub issues" },
  { name: "export_to_pm_tool", description: "Export issues to Linear/PM tool" },
  { name: "sync_linear_status", description: "Sync GitHub issue states with Linear" },
  { name: "sync_classify_and_export", description: "Full issue-centric workflow: fetch, classify, group, match, label, export" },
  { name: "manage_documentation_cache", description: "Manage documentation cache" },
  { name: "compute_feature_embeddings", description: "Compute embeddings for features" },
  { name: "compute_github_issue_embeddings", description: "Compute embeddings for GitHub issues" },
  { name: "compute_discord_embeddings", description: "Compute embeddings for Discord threads" },
] as const;

export function getAvailableTools() {
  return AVAILABLE_TOOLS;
}

// Lazy-loaded shared instances
let _discord: import("discord.js").Client | null = null;
let _discordReady = false;

async function getDiscordClient(): Promise<import("discord.js").Client> {
  if (!_discord) {
    const { Client, GatewayIntentBits } = await import("discord.js");
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error("DISCORD_TOKEN is required");

    _discord = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    _discord.once("ready", () => { _discordReady = true; });
    await _discord.login(token);

    // Wait for ready
    if (!_discordReady) {
      await new Promise<void>((resolve) => {
        _discord!.once("ready", () => resolve());
        setTimeout(() => resolve(), 10000);
      });
    }
  }
  return _discord;
}

/**
 * Execute a tool by calling existing implementations
 */
export async function executeToolHandler(
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    // =========================================================================
    // DISCORD - Use discord.js directly (simple tools)
    // =========================================================================
    
    case "list_servers": {
      const discord = await getDiscordClient();
      const guilds = discord.guilds.cache.map((g: { id: string; name: string; memberCount: number }) => ({
        id: g.id, name: g.name, member_count: g.memberCount,
      }));
      return { servers: guilds, count: guilds.length };
    }

    case "list_channels": {
      const { ChannelType } = await import("discord.js");
      const serverId = (args.server_id as string) || process.env.DISCORD_SERVER_ID;
      if (!serverId) throw new Error("server_id is required");
      
      const discord = await getDiscordClient();
      const guild = await discord.guilds.fetch(serverId);
      const channels = guild.channels.cache
        .filter((c: { type: number }) => c.type === ChannelType.GuildText)
        .map((c: { id: string; name: string }) => ({ id: c.id, name: c.name, type: "text" }));
      return { channels, count: channels.length };
    }

    case "read_messages": {
      const { ChannelType } = await import("discord.js");
      const { channel_id, limit = 50 } = args as { channel_id?: string; limit?: number };
      const discord = await getDiscordClient();
      const actualChannelId = channel_id || process.env.DISCORD_DEFAULT_CHANNEL_ID;
      
      if (!actualChannelId) {
        throw new Error("Channel ID is required. Provide channel_id parameter or set DISCORD_DEFAULT_CHANNEL_ID in environment variables.");
      }
      
      const channel = await discord.channels.fetch(actualChannelId);
      if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.DM)) {
        throw new Error("Channel not found or not a text channel");
      }
      
      const textChannel = channel as import("discord.js").TextChannel;
      const messages = await textChannel.messages.fetch({ limit: Math.min(limit, 100) });
      
      const result = Array.from(messages.values()).map((msg) => ({
        id: msg.id,
        author: {
          id: msg.author.id,
          username: msg.author.username,
          bot: msg.author.bot,
        },
        content: msg.content,
        timestamp: msg.createdAt.toISOString(),
        attachments: msg.attachments.map((a) => ({ id: a.id, filename: a.name, url: a.url })),
        embeds: msg.embeds.length,
      }));
      
      return { messages: result, count: result.length };
    }

    // =========================================================================
    // GITHUB - Call existing client functions
    // =========================================================================
    
    case "fetch_github_issues": {
      const { fetchAllGitHubIssues } = await import("../../src/connectors/github/client.js");
      const { PrismaClient } = await import("@prisma/client");
      const prisma = new PrismaClient();
      
      try {
        const incremental = args.incremental !== false;
        
        // Get since date for incremental
        let sinceDate: string | undefined;
        if (incremental) {
          const lastIssue = await prisma.gitHubIssue.findFirst({
            orderBy: { issueUpdatedAt: "desc" },
            select: { issueUpdatedAt: true },
          });
          sinceDate = lastIssue?.issueUpdatedAt?.toISOString();
        }
        
        // Call existing function
        const issues = await fetchAllGitHubIssues(
          undefined, // tokenOrManager - uses env vars
          true,      // includeClosed
          undefined, // owner - uses config
          undefined, // repo - uses config  
          sinceDate,
          args.limit as number | undefined,
          true       // includeComments
        );
        
        // Save to database
        for (const issue of issues) {
          await prisma.gitHubIssue.upsert({
            where: { issueNumber: issue.number },
            create: {
              issueNumber: issue.number,
              issueTitle: issue.title,
              issueBody: issue.body,
              issueUrl: issue.html_url,
              issueState: issue.state,
              issueLabels: issue.labels.map((l) => l.name),
              issueAssignees: issue.assignees?.map((a) => a.login) || [],
              issueAuthor: issue.user?.login,
              issueCreatedAt: new Date(issue.created_at),
              issueUpdatedAt: new Date(issue.updated_at),
              issueComments: issue.comments ? (JSON.parse(JSON.stringify(issue.comments)) as Prisma.InputJsonValue) : [],
              issueMilestone: issue.milestone?.title,
            },
            update: {
              issueTitle: issue.title,
              issueBody: issue.body,
              issueState: issue.state,
              issueLabels: issue.labels.map((l) => l.name),
              issueAssignees: issue.assignees?.map((a) => a.login) || [],
              issueUpdatedAt: new Date(issue.updated_at),
              issueComments: issue.comments ? (JSON.parse(JSON.stringify(issue.comments)) as Prisma.InputJsonValue) : [],
              issueMilestone: issue.milestone?.title,
            },
          });
        }
        
        const total = await prisma.gitHubIssue.count();
        const open = await prisma.gitHubIssue.count({ where: { issueState: "open" } });
        return { total, open, closed: total - open, new_updated: issues.length };
      } finally {
        await prisma.$disconnect();
      }
    }

    case "search_github_issues": {
      const { searchGitHubIssues } = await import("../../src/connectors/github/client.js");
      const query = args.query as string;
      if (!query) throw new Error("query is required");
      
      const results = await searchGitHubIssues(query);
      const count = results.items?.length || 0;
      return { results, count };
    }

    // =========================================================================
    // DISCORD FETCH - Call existing fetch logic
    // =========================================================================
    
    case "fetch_discord_messages": {
      const { ChannelType, TextChannel } = await import("discord.js");
      const { PrismaClient } = await import("@prisma/client");
      const prisma = new PrismaClient();
      
      try {
        const channelId = (args.channel_id as string) || process.env.DISCORD_DEFAULT_CHANNEL_ID;
        if (!channelId) throw new Error("channel_id is required");
        
        const incremental = args.incremental !== false;
        const discord = await getDiscordClient();
        const channel = await discord.channels.fetch(channelId);
        
        if (!channel || channel.type !== ChannelType.GuildText) {
          throw new Error("Channel not found or not a text channel");
        }
        
        const textChannel = channel as import("discord.js").TextChannel;
        
        // Get since date for incremental
        let sinceDate: Date | null = null;
        if (incremental) {
          const lastMsg = await prisma.discordMessage.findFirst({
            where: { channelId },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
          });
          sinceDate = lastMsg?.createdAt || null;
        }
        
        // Ensure channel exists
        await prisma.channel.upsert({
          where: { id: channelId },
          create: { id: channelId, name: textChannel.name },
          update: { name: textChannel.name },
        });
        
        // Fetch messages
        const messages: Array<{
          id: string;
          channel: { id: string };
          author: { id: string; username: string; bot: boolean };
          content: string;
          createdAt: Date;
          createdTimestamp: number;
          editedAt: Date | null;
          thread?: { id: string; name: string };
          url: string;
        }> = [];
        let lastId: string | undefined;
        
        while (true) {
          const batch = await textChannel.messages.fetch({ limit: 100, before: lastId });
          if (batch.size === 0) break;
          
          const batchArray = Array.from(batch.values());
          const filtered = sinceDate
            ? batchArray.filter((m) => m.createdAt > sinceDate!)
            : batchArray;
          
          // Convert Discord.js Message to our format
          for (const msg of filtered) {
            messages.push({
              id: msg.id,
              channel: { id: msg.channel.id },
              author: {
                id: msg.author.id,
                username: msg.author.username,
                bot: msg.author.bot,
              },
              content: msg.content,
              createdAt: msg.createdAt,
              createdTimestamp: msg.createdTimestamp,
              editedAt: msg.editedAt,
              thread: msg.thread ? { id: msg.thread.id, name: msg.thread.name || "" } : undefined,
              url: msg.url,
            });
          }
          
          // Stop if we've gone past our since date
          if (sinceDate && filtered.length < batchArray.length) break;
          if (batch.size < 100) break;
          
          lastId = batchArray[batchArray.length - 1]?.id;
        }
        
        // Save to database
        for (const msg of messages) {
          await prisma.discordMessage.upsert({
            where: { id: msg.id },
            create: {
              id: msg.id,
              channelId: msg.channel.id,
              authorId: msg.author.id,
              authorUsername: msg.author.username,
              authorBot: msg.author.bot,
              content: msg.content,
              createdAt: msg.createdAt,
              editedAt: msg.editedAt,
              timestamp: msg.createdTimestamp.toString(),
              threadId: msg.thread?.id,
              threadName: msg.thread?.name,
              url: msg.url,
            },
            update: { content: msg.content, editedAt: msg.editedAt },
          });
        }
        
        const total = await prisma.discordMessage.count({ where: { channelId } });
        return { total, new_updated: messages.length, incremental };
      } finally {
        await prisma.$disconnect();
      }
    }

    // =========================================================================
    // CLASSIFICATION - Call existing classifier
    // =========================================================================
    
    case "classify_discord_messages": {
      const { classifyMessagesWithCache } = await import("../../src/core/classify/classifier.js");
      const { PrismaClient } = await import("@prisma/client");
      const prisma = new PrismaClient();
      
      try {
        const channelId = (args.channel_id as string) || process.env.DISCORD_DEFAULT_CHANNEL_ID;
        if (!channelId) throw new Error("channel_id is required");
        const minSimilarity = (args.min_similarity as number) || 20;
        
        // Get unclassified threads
        const threads = await prisma.discordMessage.findMany({
          where: { channelId, threadId: { not: null } },
          distinct: ["threadId"],
          select: { threadId: true, threadName: true, content: true, authorUsername: true, createdAt: true },
        });
        
        const classified = await prisma.classifiedThread.findMany({
          where: { channelId },
          select: { threadId: true },
        });
        const classifiedSet = new Set(classified.map((t) => t.threadId));
        const toClassify = threads.filter((t) => t.threadId && !classifiedSet.has(t.threadId));
        
        if (toClassify.length === 0) {
          return { processed: 0, matched: 0, below_threshold: 0, message: "No new threads" };
        }
        
        // Get issues
        const issues = await prisma.gitHubIssue.findMany({
          where: { issueState: "open" },
          select: { issueNumber: true, issueTitle: true, issueBody: true, issueUrl: true, issueState: true, issueLabels: true },
        });
        
        const issuesForMatch = issues.map((i) => ({
          id: i.issueNumber, number: i.issueNumber, title: i.issueTitle, body: i.issueBody || "",
          state: i.issueState as "open" | "closed", created_at: "", updated_at: "",
          user: { login: "", avatar_url: "" }, labels: i.issueLabels.map((n) => ({ name: n, color: "" })),
          html_url: i.issueUrl, assignees: [], milestone: null, reactions: undefined, comments: [],
        }));
        
        let matched = 0, belowThreshold = 0;
        
        for (const thread of toClassify) {
          if (!thread.threadId) continue;
          
          try {
            const msgs = [{
              id: thread.threadId,
              content: thread.content,
              author: thread.authorUsername || "",
              timestamp: thread.createdAt.toISOString(),
              thread_id: thread.threadId,
              thread_name: thread.threadName || undefined,
            }];
            
            const results = await classifyMessagesWithCache(msgs, issuesForMatch);
            
            if (results.length > 0 && results[0].relatedIssues?.length > 0) {
              const topMatch = results[0].relatedIssues[0];
              const hasMatch = topMatch.similarityScore >= minSimilarity;
              
              await prisma.classifiedThread.upsert({
                where: { threadId: thread.threadId },
                create: {
                  threadId: thread.threadId,
                  channelId,
                  threadName: thread.threadName,
                  status: "completed",
                  matchStatus: hasMatch ? "matched" : "below_threshold",
                },
                update: { status: "completed", matchStatus: hasMatch ? "matched" : "below_threshold" },
              });
              
              hasMatch ? matched++ : belowThreshold++;
            }
          } catch (err) {
            console.error(`Error classifying thread ${thread.threadId}:`, err);
          }
        }
        
        return { processed: toClassify.length, matched, below_threshold: belowThreshold };
      } finally {
        await prisma.$disconnect();
      }
    }

    // =========================================================================
    // EXPORT - Call existing export logic
    // =========================================================================
    
    case "export_to_pm_tool": {
      const { exportIssuesToPMTool } = await import("../../src/export/groupingExporter.js");
      
      const pmToolConfig = {
        type: (process.env.PM_TOOL_TYPE || "linear") as "linear" | "jira" | "github" | "custom",
        api_key: process.env.PM_TOOL_API_KEY || "",
        api_url: process.env.PM_TOOL_API_URL,
        team_id: process.env.PM_TOOL_TEAM_ID,
      };
      
      if (!pmToolConfig.api_key) throw new Error("PM_TOOL_API_KEY is required");
      
      const result = await exportIssuesToPMTool(pmToolConfig, {
        include_closed: args.include_closed === true,
        channelId: args.channel_id as string,
      });
      
      return {
        success: result.success,
        created: result.issues_exported?.created || 0,
        updated: result.issues_exported?.updated || 0,
        skipped: result.issues_exported?.skipped || 0,
      };
    }

    case "sync_linear_status": {
      const { syncLinearStatus } = await import("../../src/sync/linearStatusSync.js");
      return await syncLinearStatus({ dryRun: args.dry_run === true });
    }

    // =========================================================================
    // WORKFLOW - Orchestrate other tools
    // =========================================================================
    
    case "sync_classify_and_export": {
      // Issue-centric workflow: GitHub issues are primary, Discord threads attached as context
      // All steps are incremental (only process new/unprocessed items)
      // All matching uses embeddings
      const channelId = (args.channel_id as string) || process.env.DISCORD_DEFAULT_CHANNEL_ID;
      if (!channelId) throw new Error("channel_id is required");
      
      const results: Record<string, unknown> = {};
      
      // Step 1: Fetch new GitHub issues (PRIMARY - incremental)
      console.log("[Workflow] Step 1: Fetching new GitHub issues...");
      results.github = await executeToolHandler("fetch_github_issues", { incremental: true });
      
      // Step 2: Fetch new Discord messages (incremental)
      console.log("[Workflow] Step 2: Fetching new Discord messages...");
      results.discord = await executeToolHandler("fetch_discord_messages", { channel_id: channelId, incremental: true });
      
      // Step 3: Compute embeddings (incremental - only new issues/threads)
      console.log("[Workflow] Step 3: Computing embeddings...");
      try {
        results.embeddings = await executeToolHandler("compute_embeddings", { channel_id: channelId });
      } catch (err) {
        results.embeddings = { skipped: true, reason: err instanceof Error ? err.message : "No API key" };
      }
      
      // Step 4: Group ungrouped issues (using embeddings)
      console.log("[Workflow] Step 4: Grouping new issues...");
      results.grouping = await executeToolHandler("group_github_issues", { min_similarity: 80 }); // force=false by default
      
      // Step 5: Match issues to Discord threads (issue-centric, using embeddings)
      console.log("[Workflow] Step 5: Matching issues to threads...");
      results.matching = await executeToolHandler("match_issues_to_threads", { min_similarity: 50 });
      
      // Step 6: Label unlabeled issues (using LLM)
      console.log("[Workflow] Step 6: Labeling new issues...");
      try {
        results.labeling = await executeToolHandler("label_github_issues", {}); // force=false by default
      } catch (err) {
        results.labeling = { skipped: true, reason: err instanceof Error ? err.message : "No API key" };
      }
      
      // Step 7: Match issues to features (using embeddings)
      console.log("[Workflow] Step 7: Matching issues to features...");
      try {
        results.feature_matching = await executeToolHandler("match_issues_to_features", {});
      } catch (err) {
        results.feature_matching = { skipped: true, reason: err instanceof Error ? err.message : "No features" };
      }
      
      // Step 8: Export unexported issues to PM tool
      console.log("[Workflow] Step 8: Exporting new issues...");
      try {
        results.export = await executeToolHandler("export_to_pm_tool", { channel_id: channelId });
      } catch (err) {
        results.export = { skipped: true, reason: err instanceof Error ? err.message : "Export failed" };
      }
      
      // Step 9: Sync Linear status for existing tickets
      console.log("[Workflow] Step 9: Syncing Linear status...");
      try {
        results.sync = await executeToolHandler("sync_linear_status", {});
      } catch (err) {
        results.sync = { skipped: true, reason: err instanceof Error ? err.message : "Sync failed" };
      }
      
      console.log("[Workflow] Complete!");
      return results;
    }

    // =========================================================================
    // GROUPING - Call existing grouping logic
    // =========================================================================
    
    case "group_github_issues": {
      // Use existing embedding helpers
      const { computeAndSaveIssueEmbeddings } = await import("../../src/storage/db/embeddings.js");
      const { prisma } = await import("../../src/storage/db/prisma.js");
      
      const minSimilarity = (args.min_similarity as number) || 80;
      const includeClosed = args.include_closed === true;
      const force = args.force === true;
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY required");
      
      // Step 1: Compute embeddings (incremental)
      await computeAndSaveIssueEmbeddings(apiKey, undefined, false);
      
      // Step 2: Get ungrouped issues only
      const issues = await prisma.gitHubIssue.findMany({
        where: {
          ...(includeClosed ? {} : { issueState: "open" }),
          ...(force ? {} : { groupId: null }),
        },
      });
      
      if (issues.length === 0) return { groups_created: 0, issues_grouped: 0, message: "No ungrouped issues" };
      
      // Step 3: Load embeddings
      const embeddings = await prisma.issueEmbedding.findMany({ where: { issueNumber: { in: issues.map(i => i.issueNumber) } } });
      const embMap = new Map(embeddings.map(e => [e.issueNumber, e.embedding as number[]]));
      
      // Step 4: Group by similarity
      const groups: number[][] = [];
      const grouped = new Set<number>();
      
      for (const issue of issues) {
        if (grouped.has(issue.issueNumber)) continue;
        const emb1 = embMap.get(issue.issueNumber);
        if (!emb1) continue;
        
        const group = [issue.issueNumber];
        grouped.add(issue.issueNumber);
        
        for (const other of issues) {
          if (grouped.has(other.issueNumber)) continue;
          const emb2 = embMap.get(other.issueNumber);
          if (!emb2) continue;
          
          const dot = emb1.reduce((s, a, i) => s + a * emb2[i], 0);
          const norm1 = Math.sqrt(emb1.reduce((s, a) => s + a * a, 0));
          const norm2 = Math.sqrt(emb2.reduce((s, a) => s + a * a, 0));
          const similarity = (dot / (norm1 * norm2)) * 100;
          
          if (similarity >= minSimilarity) {
            group.push(other.issueNumber);
            grouped.add(other.issueNumber);
          }
        }
        
        if (group.length > 1) groups.push(group);
      }
      
      // Step 5: Save groups
      for (const group of groups) {
        const groupId = `group-${group[0]}-${Date.now()}`;
        const primary = issues.find(i => i.issueNumber === group[0])!;
        
        await prisma.group.create({
          data: { id: groupId, channelId: process.env.DISCORD_DEFAULT_CHANNEL_ID || "default", suggestedTitle: primary.issueTitle, githubIssueNumber: primary.issueNumber, threadCount: group.length },
        });
        
        for (const num of group) {
          await prisma.gitHubIssue.update({ where: { issueNumber: num }, data: { groupId, inGroup: true } });
        }
      }
      
      return { groups_created: groups.length, issues_grouped: grouped.size, ungrouped: issues.length - grouped.size };
    }

    case "label_github_issues": {
      const { PrismaClient } = await import("@prisma/client");
      const prisma = new PrismaClient();
      
      try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error("OPENAI_API_KEY required");
        
        const issues = await prisma.gitHubIssue.findMany({
          where: {
            ...(args.include_closed ? {} : { issueState: "open" }),
            ...(args.force ? {} : { detectedLabels: { isEmpty: true } }),
          },
        });
        
        if (issues.length === 0) return { labeled: 0 };
        
        let labeled = 0;
        for (const issue of issues) {
          const prompt = `Analyze this GitHub issue and return ONLY a JSON array of applicable labels from: ["bug", "security", "regression", "enhancement", "urgent"]

Title: ${issue.issueTitle}
Body: ${issue.issueBody?.slice(0, 1000) || "No description"}`;

          const resp = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], temperature: 0 }),
          });
          
          const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
          try {
            const labels = JSON.parse(data.choices?.[0]?.message?.content?.replace(/```json?\n?/g, "").replace(/```/g, "") || "[]");
            if (Array.isArray(labels)) {
              await prisma.gitHubIssue.update({ where: { issueNumber: issue.issueNumber }, data: { detectedLabels: labels } });
              labeled++;
            }
          } catch { /* skip */ }
        }
        
        return { labeled, total: issues.length };
      } finally {
        await prisma.$disconnect();
      }
    }

    // =========================================================================
    // FEATURE MATCHING - Call existing logic
    // =========================================================================
    
    case "match_issues_to_features": {
      const { PrismaClient } = await import("@prisma/client");
      const { createEmbedding } = await import("../../src/core/classify/semantic.js");
      const prisma = new PrismaClient();
      
      try {
        const minSimilarity = (args.min_similarity as number) || 0.5;
        const includeClosed = args.include_closed === true;
        const force = args.force === true;
        
        // Get features
        const features = await prisma.feature.findMany({ include: { embedding: true } });
        if (features.length === 0) {
          return { matched: 0, message: "No features found. Run manage_documentation_cache first." };
        }
        
        // Get issues without features (or all if force)
        const issues = await prisma.gitHubIssue.findMany({
          where: {
            ...(includeClosed ? {} : { issueState: "open" }),
            ...(force ? {} : { affectsFeatures: { equals: [] } }),
          },
          include: { embedding: true },
        });
        
        if (issues.length === 0) return { matched: 0, message: "No issues to match" };
        
        let matched = 0;
        for (const issue of issues) {
          // Get or compute issue embedding
          let issueEmb = issue.embedding?.embedding as number[] | undefined;
          if (!issueEmb) {
            const text = `${issue.issueTitle}\n${issue.issueBody || ""}`;
            const apiKey = process.env.OPENAI_API_KEY;
            if (!apiKey) throw new Error("OPENAI_API_KEY required");
            issueEmb = await createEmbedding(text, apiKey);
          }
          
          const matchedFeatures: { id: string; name: string; similarity: number }[] = [];
          
          for (const feature of features) {
            const featureEmb = feature.embedding?.embedding as number[] | undefined;
            if (!featureEmb) continue;
            
            // Cosine similarity
            const dot = issueEmb.reduce((sum, a, i) => sum + a * featureEmb[i], 0);
            const norm1 = Math.sqrt(issueEmb.reduce((sum, a) => sum + a * a, 0));
            const norm2 = Math.sqrt(featureEmb.reduce((sum, a) => sum + a * a, 0));
            const similarity = dot / (norm1 * norm2);
            
            if (similarity >= minSimilarity) {
              matchedFeatures.push({ id: feature.id, name: feature.name, similarity });
            }
          }
          
          if (matchedFeatures.length > 0) {
            await prisma.gitHubIssue.update({
              where: { issueNumber: issue.issueNumber },
              data: { affectsFeatures: matchedFeatures.map(f => ({ id: f.id, name: f.name })) },
            });
            matched++;
          }
        }
        
        return { matched, total_issues: issues.length, features_available: features.length };
      } finally {
        await prisma.$disconnect();
      }
    }

    case "match_issues_to_threads": {
      // Use existing embedding helpers
      const { computeAndSaveIssueEmbeddings, computeAndSaveThreadEmbeddings } = await import("../../src/storage/db/embeddings.js");
      const { prisma } = await import("../../src/storage/db/prisma.js");
      
      const minSimilarity = (args.min_similarity as number) || 50;
      const includeClosed = args.include_closed === true;
      const force = args.force === true;
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY required");
      
      // Step 1: Compute embeddings (incremental - only missing ones)
      const issueEmbResult = await computeAndSaveIssueEmbeddings(apiKey, undefined, false);
      const threadEmbResult = await computeAndSaveThreadEmbeddings(apiKey, {});
      
      // Step 2: Get unmatched issues only (unless force)
      const issues = await prisma.gitHubIssue.findMany({
        where: {
          ...(includeClosed ? {} : { issueState: "open" }),
          ...(force ? {} : { matchedToThreads: false }),
        },
        select: { issueNumber: true, issueTitle: true },
      });
      
      if (issues.length === 0) {
        return { issues_processed: 0, message: "No new issues to match", embeddings: { issues: issueEmbResult, threads: threadEmbResult } };
      }
      
      // Step 3: Load embeddings and match
      const issueEmbs = await prisma.issueEmbedding.findMany({ where: { issueNumber: { in: issues.map(i => i.issueNumber) } } });
      const threadEmbs = await prisma.threadEmbedding.findMany({});
      
      const issueEmbMap = new Map(issueEmbs.map(e => [e.issueNumber, e.embedding as number[]]));
      let matchesCreated = 0;
      
      for (const issue of issues) {
        const issueEmb = issueEmbMap.get(issue.issueNumber);
        if (!issueEmb) continue;
        
        for (const threadEmb of threadEmbs) {
          const emb = threadEmb.embedding as number[];
          const dot = issueEmb.reduce((s, a, i) => s + a * emb[i], 0);
          const norm1 = Math.sqrt(issueEmb.reduce((s, a) => s + a * a, 0));
          const norm2 = Math.sqrt(emb.reduce((s, a) => s + a * a, 0));
          const similarity = (dot / (norm1 * norm2)) * 100;
          
          if (similarity >= minSimilarity) {
            await prisma.issueThreadMatch.upsert({
              where: { issueNumber_threadId: { issueNumber: issue.issueNumber, threadId: threadEmb.threadId } },
              create: { issueNumber: issue.issueNumber, threadId: threadEmb.threadId, similarityScore: similarity },
              update: { similarityScore: similarity },
            });
            matchesCreated++;
          }
        }
        
        await prisma.gitHubIssue.update({ where: { issueNumber: issue.issueNumber }, data: { matchedToThreads: true } });
      }
      
      return { issues_processed: issues.length, matches_created: matchesCreated };
    }

    // More tools can be added by calling their existing implementations...

    default:
      throw new Error(`Unknown tool: ${toolName}. Available: ${AVAILABLE_TOOLS.map(t => t.name).join(", ")}`);
  }
}

/**
 * Cleanup resources
 */
export async function cleanupToolExecutor(): Promise<void> {
  if (_discord) {
    _discord.destroy();
    _discord = null;
    _discordReady = false;
  }
}
