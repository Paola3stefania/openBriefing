#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { logError } from "./logger.js";
import { detectProjectId } from "../config/project.js";


/**
 * Construct a typed `ExternalRef` from the loose `link_external_event` tool
 * args. Branching on `source` so the stored ref is the strict tagged-union
 * shape (slack_thread / notion_page / github_pr / ...) rather than a generic
 * bag of optional fields.
 *
 * Heuristic fallbacks:
 *   - github source with a URL like `.../pull/N` → `github_pr`, otherwise
 *     `github_issue` (matches GitHub URL conventions).
 *   - file source: keeps `path` and optional `sha`.
 *   - other / unknown sources fall through to `kind: "other"`.
 */
function buildExternalRef(input: {
  source: string;
  url: string;
  text: string;
  role: "decision" | "open_item" | "reference";
  channel?: string;
  ts?: string;
  pageId?: string;
  repo?: string;
  number?: number;
  identifier?: string;
  path?: string;
  sha?: string;
  guildId?: string;
  threadId?: string;
}): import("../briefing/types.js").ExternalRef {
  const addedAt = new Date().toISOString();
  const base = { text: input.text, url: input.url, role: input.role, addedAt } as const;
  switch (input.source) {
    case "slack":
      return { kind: "slack_thread", ...base, channel: input.channel, ts: input.ts };
    case "notion":
      return { kind: "notion_page", ...base, pageId: input.pageId };
    case "github": {
      const isPr = /\/pull\//i.test(input.url);
      return {
        kind: isPr ? "github_pr" : "github_issue",
        ...base,
        repo: input.repo,
        number: input.number,
      };
    }
    case "linear":
      return { kind: "linear_issue", ...base, identifier: input.identifier };
    case "file":
      return { kind: "file", ...base, path: input.path, sha: input.sha };
    case "discord":
      return {
        kind: "discord_thread",
        ...base,
        guildId: input.guildId,
        channelId: input.channel,
        threadId: input.threadId,
      };
    default:
      return { kind: "other", ...base };
  }
}

/**
 * Resolve the project identifier from a tool args bag.
 *
 * Memory tools (and a few others) historically shipped with `project_id`,
 * while the rest of the OpenBriefing surface area uses `project`. The skill
 * tells callers to "always pass `project`", so we accept both spellings and
 * prefer `project` to match the rest of the API. Returns `undefined` when
 * neither is provided so the storage layer can fall back to its own
 * `detectProjectId()` (the legacy behavior).
 */
function resolveProjectArg(args: Record<string, unknown> | undefined | null): string | undefined {
  if (!args) return undefined;
  const project = args.project;
  if (typeof project === "string" && project.trim().length > 0) return project;
  const projectId = args.project_id;
  if (typeof projectId === "string" && projectId.trim().length > 0) return projectId;
  return undefined;
}

/**
 * Safely parse JSON with better error messages
 */
function safeJsonParse<T = unknown>(content: string, filePath?: string): T {
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const fileContext = filePath ? ` in file: ${filePath}` : "";
    const preview = content.substring(0, 100).replace(/\n/g, " ");
    throw new Error(`Failed to parse JSON${fileContext}: ${errorMessage}. Content preview: ${preview}...`);
  }
}

// Create MCP server
const mcpServer = new McpServer(
  {
  name: "openbriefing",
  version: "1.0.0",
  },
  {
    instructions: [
      "OpenBriefing provides project context, session memory, and code understanding for AI agents.",
      "",
      "At the START of every conversation:",
      "1. Call get_agent_briefing to understand the current project state (recent decisions, open items, actionable plan steps, codebase notes)",
      "2. Call get_session_history to see what previous agent sessions worked on and what open items remain",
      "3. Use this context to inform your responses — avoid duplicating past work or revisiting resolved decisions",
      "",
      "During meaningful work sessions:",
      "1. Call start_agent_session at the beginning with the scope of work (e.g., ['agent-auth', 'mcp-tools'])",
      "2. Call update_agent_session periodically to record progress mid-session",
      "3. Call end_agent_session when done, recording: decisions_made, files_edited, open_items, related_insights, and a summary",
      "",
      "This session data powers the next agent's briefing — what you record here is what the next agent will know.",
      "",
      "OpenBriefing covers memory, sessions, briefings, and code (index_codebase, code ownership, investigate_issue, learn_from_pr). For outside-world signals — Discord, GitHub issues/PRs, X, and Linear/PM exports — use the unMute MCP server alongside it; an agent can combine both.",
    ].join("\n"),
    capabilities: {
      tools: {},
    },
  }
);

const tools: Tool[] = [
  {
    name: "index_codebase",
    description: "Manually search and index code from the repository for a specific query. This is useful for pre-indexing code or re-indexing after code changes. The indexed code will be available for feature matching. Will use LOCAL_REPO_PATH if configured (faster), otherwise falls back to GITHUB_REPO_URL. Requires either LOCAL_REPO_PATH or GITHUB_REPO_URL to be configured.",
    inputSchema: {
      type: "object",
      properties: {
        search_query: {
          type: "string",
          description: "Search query to find relevant code (e.g., 'SSO authentication', 'session management'). The code matching this query will be indexed.",
          default: "",
        },
        force: {
          type: "boolean",
          description: "Force re-indexing even if code is already indexed. Useful after code changes.",
          default: false,
        },
      },
      required: ["search_query"],
    },
  },
  {
    name: "index_code_for_features",
    description: "Proactively index code for all features (similar to documentation workflow). This searches and indexes code for each feature, matches code sections to features, and saves embeddings. This should be run before computing feature embeddings to ensure code context is available. Auto-detects the current git repository root if called from within a git repo. Otherwise uses LOCAL_REPO_PATH from config, or falls back to GITHUB_REPO_URL. Can be called from any repository context - uses semantic search with LLM embeddings to find relevant code.",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "Force re-indexing even if code is already indexed for features. Useful after code changes.",
          default: false,
        },
        local_repo_path: {
          type: "string",
          description: "Optional: Override the configured LOCAL_REPO_PATH. Useful when calling from a different repository context. If not provided, uses the configured LOCAL_REPO_PATH from environment.",
        },
        github_repo_url: {
          type: "string",
          description: "Optional: Override the configured GITHUB_REPO_URL. If not provided, uses the configured GITHUB_REPO_URL from environment.",
        },
        max_files: {
          type: ["number", "null"],
          description: "Maximum number of files to index per batch (default: null = process entire repository). If null, processes ALL files in the repository in chunks. If set, processes that many files total. Lower values process faster but may miss relevant code.",
          default: null,
        },
        chunk_size: {
          type: "number",
          description: "Number of files to process per chunk (default: 100). This is for batching the processing, not a total limit. Use max_files to limit total files.",
          default: 100,
          minimum: 1,
          maximum: 500,
        },
      },
    },
  },
  {
    name: "analyze_code_ownership",
    description: "Analyze codebase commit history to determine code ownership by engineers. Calculates what percentage of code belongs to each engineer, then maps to features for recommended assignees. This enables automatic assignment suggestions in Linear issues based on who has worked on related code.",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "If true, re-analyze even if recent analysis exists. If false (default), skip if analysis is less than 24 hours old.",
          default: false,
        },
        since: {
          type: "string",
          description: "ISO date string to analyze commits since (e.g., '2024-01-01T00:00:00Z'). If not provided, analyzes all commits.",
        },
        calculate_feature_ownership: {
          type: "boolean",
          description: "If true (default), also calculate feature-level ownership after file analysis. This maps file ownership to features for better assignee recommendations.",
          default: true,
        },
      },
      required: [],
    },
  },
  {
    name: "view_feature_ownership",
    description: "View feature ownership table showing all features and the percentage of code owned by each engineer. Displays as a formatted table with engineer names, ownership percentages, file counts, and total lines.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["table", "json"],
          description: "Output format: 'table' (markdown table, default) or 'json' (structured data)",
          default: "table",
        },
      },
      required: [],
    },
  },
  // ============================================================================
  // PR Fix Tools - Learning and Fix Generation
  // ============================================================================
  {
    name: "seed_pr_learnings",
    description: "One-time seeding: fetch all historical closed issues with merged PRs and populate the PRLearning table. This bootstraps the learning system with past fixes so investigate_issue has examples from day 1. Requires DATABASE_URL and GITHUB_TOKEN.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repository in format 'owner/repo'. Defaults to GITHUB_OWNER/GITHUB_REPO from config.",
        },
        since: {
          type: "string",
          description: "ISO date to fetch issues from (e.g., '2023-01-01'). Defaults to all time.",
        },
        limit: {
          type: "number",
          description: "Max number of issues to process. Defaults to all.",
        },
        dry_run: {
          type: "boolean",
          description: "Show what would be seeded without actually storing.",
          default: false,
        },
        batch_size: {
          type: "number",
          description: "Number of issues to process per batch (for rate limiting). Default: 50.",
          default: 50,
        },
      },
      required: [],
    },
  },
  {
    name: "learn_from_pr",
    description: "Learn from a merged PR: store the issue+PR+diff+feedback for future reference. Can be triggered manually or via webhook when PRs are merged. Requires DATABASE_URL and GITHUB_TOKEN.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repository in format 'owner/repo'. Defaults to GITHUB_OWNER/GITHUB_REPO from config.",
        },
        pr_number: {
          type: "number",
          description: "PR number to learn from.",
        },
        force: {
          type: "boolean",
          description: "Re-learn even if already processed.",
          default: false,
        },
      },
      required: ["pr_number"],
    },
  },
  {
    name: "investigate_issue",
    description: "Investigate a GitHub issue: gather full context (title, body, comments, labels), triage to determine issue type (bug vs config vs feature vs question), and find similar historical fixes from the learning database. Returns recommendation on whether to attempt a fix. Requires DATABASE_URL and GITHUB_TOKEN.",
    inputSchema: {
      type: "object",
      properties: {
        issue_number: {
          type: "number",
          description: "GitHub issue number to investigate.",
        },
        repo: {
          type: "string",
          description: "Repository in format 'owner/repo'. Defaults to GITHUB_REPO_URL from config.",
        },
        include_discord: {
          type: "boolean",
          description: "Include matched Discord threads in context.",
          default: true,
        },
        max_similar_fixes: {
          type: "number",
          description: "Max number of similar historical fixes to return.",
          default: 5,
        },
      },
      required: ["issue_number"],
    },
  },
  {
    name: "get_agent_briefing",
    description: "Get a structured project context briefing optimized for agent consumption. Returns a compact JSON payload (~300-500 tokens) with active issues, user signals, recent decisions, codebase notes, and activity metrics. Call this at the start of a session to understand the current project state. IMPORTANT: Always pass 'project' — detect it from the workspace git remote (owner/repo) or folder name.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "Optional focus area to filter the briefing (e.g., 'auth', 'billing', 'agent-auth'). When provided, only issues/signals/decisions related to this area are included.",
        },
        since: {
          type: "string",
          description: "Optional ISO timestamp to look back from. Defaults to last 14 days. Use the timestamp from a previous session to see only what changed.",
        },
        project: {
          type: "string",
          description: "Project identifier — use 'owner/repo' from the workspace git remote origin, or the workspace folder name if no remote. The MCP server cannot detect your workspace, so always pass this.",
        },
      },
      required: [],
    },
  },
  {
    name: "start_agent_session",
    description: "Start a new agent session for tracking purposes. Returns a session ID that should be passed to end_agent_session when the session completes. IMPORTANT: Always pass 'project' — detect it from the workspace git remote (owner/repo) or folder name.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "array",
          items: { type: "string" },
          description: "Areas the agent plans to work on (e.g., ['agent-auth', 'mcp-tools.ts']).",
        },
        project: {
          type: "string",
          description: "Project identifier — use 'owner/repo' from the workspace git remote origin, or the workspace folder name if no remote. The MCP server cannot detect your workspace, so always pass this.",
        },
      },
      required: [],
    },
  },
  {
    name: "end_agent_session",
    description: "End an agent session and record what was accomplished. Stores files edited, decisions made, plan steps, open items, and issues referenced so future briefings can highlight changes. Pass `related_insights` to also persist free-form debrief content as session-linked memories — that's the right place for 'why we chose X' or 'spec is the source of truth' framings instead of a separate save_memory call.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID returned by start_agent_session.",
        },
        files_edited: {
          type: "array",
          items: { type: "string" },
          description: "List of files edited during this session.",
        },
        decisions_made: {
          type: "array",
          items: { type: "string" },
          description: "Key decisions made during this session (e.g., 'split mcp-tools into separate files').",
        },
        open_items: {
          type: "array",
          items: { type: "string" },
          description: "Items left open that need follow-up.",
        },
        issues_referenced: {
          type: "array",
          items: { type: "string" },
          description: "Issue IDs referenced during the session (e.g., ['#423', '#451']).",
        },
        tools_used: {
          type: "array",
          items: { type: "string" },
          description: "MCP tools used during the session.",
        },
        plan_steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique step identifier (e.g., '1', 'auth-setup')." },
              description: { type: "string", description: "What this step accomplishes." },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"], description: "Current status of this step." },
              notes: { type: "string", description: "Optional context — why blocked, what was learned, etc." },
            },
            required: ["id", "description", "status"],
          },
          description: "Structured plan steps with statuses. Save your plan here so the next agent can pick up where you left off. Each step has an id, description, status (pending/in_progress/completed/blocked), and optional notes.",
        },
        summary: {
          type: "string",
          description: "Brief summary of what was accomplished.",
        },
        related_insights: {
          type: "array",
          items: { type: "string" },
          description: "Free-form debrief insights to persist as session-linked memories (one per array entry). Each becomes a MemoryEntry tagged with this session id, gets embedded, and shows up in future briefings' relatedInsights[] when it matches the agent's focus query. Use this for 'why we chose X', 'unexpected gotcha Y', or 'principle Z that emerged' — content that doesn't fit decisions/openItems but should be retrievable later by meaning. Replaces the pattern of calling save_memory after end_agent_session, which fragmented the record.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "update_agent_session",
    description: "Incrementally update a running agent session. Merges new data with existing session data (arrays are deduplicated, plan steps are merged by id). Use this to record progress mid-session without ending it.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID returned by start_agent_session.",
        },
        scope: {
          type: "array",
          items: { type: "string" },
          description: "Additional scope areas discovered during work.",
        },
        files_edited: {
          type: "array",
          items: { type: "string" },
          description: "Additional files edited.",
        },
        decisions_made: {
          type: "array",
          items: { type: "string" },
          description: "Additional decisions made.",
        },
        open_items: {
          type: "array",
          items: { type: "string" },
          description: "Additional open items.",
        },
        issues_referenced: {
          type: "array",
          items: { type: "string" },
          description: "Additional issues referenced.",
        },
        tools_used: {
          type: "array",
          items: { type: "string" },
          description: "Additional tools used.",
        },
        plan_steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique step identifier (e.g., '1', 'auth-setup')." },
              description: { type: "string", description: "What this step accomplishes." },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"], description: "Current status of this step." },
              notes: { type: "string", description: "Optional context — why blocked, what was learned, etc." },
            },
            required: ["id", "description", "status"],
          },
          description: "Plan steps to add or update. Steps are merged by id — existing steps get their status/notes updated, new steps are appended.",
        },
        summary: {
          type: "string",
          description: "Updated session summary (replaces previous).",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_session_history",
    description: "Get recent agent session history for the current project. Returns compact summaries by default (scope, truncated summary, counts of files/decisions/open items, plan step status, first few open items) to stay within MCP response size limits. Pass verbose:true to get full session objects, or pass session_id to retrieve one full session.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of recent sessions to return. Default 5. Capped at 50 in compact mode and 10 in verbose mode to avoid exceeding response size limits.",
        },
        session_id: {
          type: "string",
          description: "Optional specific session ID to retrieve (always returns the full session; ignores project filter and verbose/limit).",
        },
        project: {
          type: "string",
          description: "Optional project identifier to filter sessions. Defaults to the auto-detected current project.",
        },
        verbose: {
          type: "boolean",
          description: "If true, return full session objects (filesEdited, decisionsMade, openItems, planSteps, full summary). Default false for a compact summary list.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_session_delta",
    description: "Compact diff of project state since a reference point — returns only what's NEW (decisions/open_items/completed steps/external refs) since `since`, not the full recent-sessions view. Use when resuming a project after a break instead of pulling get_session_history. Cheaper in tokens; returns ~200-400 tokens vs get_session_history's ~1k.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "Reference point. Accepts: a session ID (delta runs from that session's startedAt), an ISO 8601 timestamp, or any value parseable by Date(). If unparseable, falls back to 30 days ago so the tool always returns something useful.",
        },
        scope: {
          type: "string",
          description: "Optional scope substring (case-insensitive) to filter the delta. Sessions whose scope/decisions/open_items don't mention it are excluded.",
        },
        project: {
          type: "string",
          description: "Project identifier — use 'owner/repo' from the workspace git remote origin, or the workspace folder name if no remote. The MCP server cannot detect your workspace, so always pass this.",
        },
      },
      required: ["since"],
    },
  },
  {
    name: "link_external_event",
    description: "Bind a typed pointer to an artifact on another surface (Slack thread, Notion page, GitHub PR/issue, Linear issue, file, Discord thread, ...) to the active session. Use this instead of stuffing 'Dan ratified X in Slack <url>' into open_items as a string — produces a navigable, structured reference the next agent can follow. Resolves the active session as the most-recent amendable session for the project (running, OR ended within OPENBRIEFING_SESSION_AMEND_WINDOW_MS — default 24h). Pass session_id to override.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["slack", "notion", "github", "linear", "file", "discord", "other"],
          description: "What surface this artifact lives on. Drives the structured fields populated on the stored ref (slack_thread → channel/ts, github → repo/number, etc.).",
        },
        url: {
          type: "string",
          description: "Canonical URL for the artifact. Used as the dedupe key — re-linking the same URL replaces the previous ref so labels/role can be updated.",
        },
        text: {
          type: "string",
          description: "Human-readable label. Renders in the session view without dereferencing the URL (e.g., 'Dan ratified orchestrator service_mode').",
        },
        kind: {
          type: "string",
          enum: ["decision", "open_item", "reference"],
          description: "What this reference represents in the session — 'decision' (a binding decision was recorded elsewhere), 'open_item' (a follow-up to track), or 'reference' (supporting context). Defaults to 'reference'.",
        },
        channel: {
          type: "string",
          description: "Slack: channel ID (e.g., 'C0AGL9PDTAS'). Discord: channel ID. Ignored for other sources.",
        },
        ts: {
          type: "string",
          description: "Slack thread timestamp (e.g., '1778030426.278609'). Ignored for non-slack sources.",
        },
        page_id: {
          type: "string",
          description: "Notion page ID. Ignored for non-notion sources.",
        },
        repo: {
          type: "string",
          description: "GitHub: 'owner/repo'. Ignored for non-github sources.",
        },
        number: {
          type: "number",
          description: "GitHub PR or issue number. Ignored for non-github sources.",
        },
        identifier: {
          type: "string",
          description: "Linear issue identifier (e.g., 'ENG-1234'). Ignored for non-linear sources.",
        },
        path: {
          type: "string",
          description: "File: workspace-relative path. Ignored for non-file sources.",
        },
        sha: {
          type: "string",
          description: "File: optional git sha for stability across refactors. Ignored for non-file sources.",
        },
        guild_id: {
          type: "string",
          description: "Discord: guild ID. Ignored for non-discord sources.",
        },
        thread_id: {
          type: "string",
          description: "Discord: thread ID. Ignored for non-discord sources.",
        },
        session_id: {
          type: "string",
          description: "Optional explicit session to attach to. If omitted, picks the most-recent amendable session for `project`.",
        },
        project: {
          type: "string",
          description: "Project identifier — use 'owner/repo' from the workspace git remote origin, or the workspace folder name if no remote. Used to resolve the active session when `session_id` is not passed.",
        },
      },
      required: ["source", "url", "text"],
    },
  },
  {
    name: "import_claude_plans",
    description: "Import plans from Claude Code's ~/.claude/plans/ directory. Claude Code stores detailed implementation plans as markdown files. This tool reads them, extracts structured steps, and attaches them to the current session. Use this when starting a session if the user has been working with Claude Code.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID to attach the imported plan to.",
        },
        plan_file: {
          type: "string",
          description: "Optional specific plan filename to import (e.g., 'delegated-snuggling-turing.md'). If omitted, lists all available plans.",
        },
      },
      required: [],
    },
  },
  {
    name: "save_memory",
    description: "Save a memory entry (conversation insight, decision, learning) with semantic embedding for future retrieval. Use this to persist important things discussed so they can be recalled in future sessions. IMPORTANT: Always pass 'project' — detect it from the workspace git remote (owner/repo) or folder name. The MCP server cannot detect your workspace, so always pass this.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The full content to remember (can be a conversation snippet, decision, or learning).",
        },
        summary: {
          type: "string",
          description: "A short 1-2 sentence summary of what this memory is about.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags to categorize the memory (e.g. ['ciba', 'architecture', 'decision']).",
        },
        project: {
          type: "string",
          description: "Project identifier — use 'owner/repo' from the workspace git remote origin, or the workspace folder name if no remote. The MCP server cannot detect your workspace, so always pass this. Falls back to the MCP server's CWD-detected project (which leaks into other projects when the same DB is shared) only if omitted.",
        },
        project_id: {
          type: "string",
          description: "Deprecated alias for 'project'. Prefer 'project'.",
        },
      },
      required: ["content", "summary"],
    },
  },
  {
    name: "search_memory",
    description: "Search past memories semantically using embeddings. Returns the most relevant memories for a given query. Use at session start to recall relevant context. IMPORTANT: Always pass 'project' — detect it from the workspace git remote (owner/repo) or folder name. The MCP server cannot detect your workspace, so always pass this.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for (natural language query).",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 5).",
          default: 5,
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional: filter results by tags.",
        },
        project: {
          type: "string",
          description: "Project identifier — use 'owner/repo' from the workspace git remote origin, or the workspace folder name if no remote. The MCP server cannot detect your workspace, so always pass this. Falls back to the MCP server's CWD-detected project (which can return memories from other projects when the same DB is shared) only if omitted.",
        },
        project_id: {
          type: "string",
          description: "Deprecated alias for 'project'. Prefer 'project'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_recent_memories",
    description: "Get the most recent memory entries without a search query. Useful at session start to get a quick overview of recent context. IMPORTANT: Always pass 'project' — detect it from the workspace git remote (owner/repo) or folder name. The MCP server cannot detect your workspace, so always pass this.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of recent memories to return (default: 10).",
          default: 10,
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional: filter by tags.",
        },
        project: {
          type: "string",
          description: "Project identifier — use 'owner/repo' from the workspace git remote origin, or the workspace folder name if no remote. The MCP server cannot detect your workspace, so always pass this. Falls back to the MCP server's CWD-detected project (which can return memories from other projects when the same DB is shared) only if omitted.",
        },
        project_id: {
          type: "string",
          description: "Deprecated alias for 'project'. Prefer 'project'.",
        },
      },
      required: [],
    },
  },
  {
    name: "delete_memory",
    description: "Delete a memory entry by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The memory entry ID to delete.",
        },
      },
      required: ["id"],
    },
  },
];

// Handle list tools request
mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

// Handle call tool request
mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Extract name early so it's available in catch block
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
    case "index_codebase": {
      const { search_query, force = false, chunk_size } = args as {
        search_query: string;
        force?: boolean;
        chunk_size?: number;
      };

      if (!search_query || search_query.trim().length === 0) {
        throw new Error("search_query is required");
      }

      const { getConfig } = await import("../config/index.js");
      const config = getConfig();
      const repositoryUrl = config.pmIntegration?.github_repo_url;
      const localRepoPath = config.pmIntegration?.local_repo_path;

      if (!repositoryUrl && !localRepoPath) {
        throw new Error("Either GITHUB_REPO_URL or LOCAL_REPO_PATH must be configured to index codebase");
      }

      const { searchAndIndexCode } = await import("../storage/db/codeIndexer.js");
      
      console.error(`[CodeIndexing] Starting manual code indexing for query: "${search_query}"`);
      if (force) {
        console.error(`[CodeIndexing] Force mode enabled - will re-index even if already indexed`);
      }
      
      try {
        // Search and index code (this will use cache if not forcing)
        // Use repositoryUrl if available, otherwise use localRepoPath as fallback identifier
        const repoIdentifier = repositoryUrl || localRepoPath || "";
        const chunkSize = chunk_size ?? 100;
        const codeContext = await searchAndIndexCode(
          search_query,
          repoIdentifier,
          "", // No specific feature ID for manual indexing
          search_query,
          force,
          chunkSize
        );

        if (codeContext) {
          const fileCount = (codeContext.match(/File: /g) || []).length;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  message: `Code indexed successfully for query "${search_query}". Found ${fileCount} file(s).`,
                  code_context_length: codeContext.length,
                  file_count: fileCount,
                }, null, 2),
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  message: `No code found for query "${search_query}"`,
                }, null, 2),
              },
            ],
          };
        }
      } catch (error) {
        throw new Error(`Failed to index codebase: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "index_code_for_features": {
      const { force = false, local_repo_path, github_repo_url, chunk_size, max_files } = args as {
        force?: boolean;
        local_repo_path?: string;
        github_repo_url?: string;
        chunk_size?: number;
        max_files?: number | null;
      };

      const { getConfig } = await import("../config/index.js");
      const config = getConfig();
      
      // Get configured values (parameter > config)
      // No auto-detection - must be explicitly configured
      const repositoryUrl = github_repo_url || config.pmIntegration?.github_repo_url;
      const localRepoPath = local_repo_path || config.pmIntegration?.local_repo_path;

      if (!repositoryUrl && !localRepoPath) {
        throw new Error("Either GITHUB_REPO_URL or LOCAL_REPO_PATH must be configured to index code for features. You can provide them as parameters or set them in the MCP config (.env file).");
      }

      const { indexCodeForAllFeatures } = await import("../storage/db/codeIndexer.js");
      
      console.error(`[CodeIndexing] Starting proactive code indexing for all features...`);
      
      // Determine source of repo path for logging
      let repoPathSource = "config";
      if (local_repo_path) {
        repoPathSource = "parameter";
      } else if (config.pmIntegration?.local_repo_path) {
        repoPathSource = "config";
      }
      
      if (localRepoPath) {
        console.error(`[CodeIndexing] Using local repository path: ${localRepoPath} (source: ${repoPathSource})`);
      }
      if (repositoryUrl) {
        console.error(`[CodeIndexing] Using GitHub repository URL: ${repositoryUrl}`);
      }
      if (force) {
        console.error(`[CodeIndexing] Force mode enabled - will re-index even if already indexed`);
      }
      
      try {
        const chunkSize = chunk_size ?? 100;
        const maxFiles = max_files ?? null; // null = process entire repository in chunks
        const result = await indexCodeForAllFeatures(repositoryUrl || undefined, force, undefined, localRepoPath, chunkSize, maxFiles);
        
        // Get diagnostic info (use the same variables we already have)
        const githubRepoUrl = repositoryUrl;
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Code indexing completed for all features.`,
                indexed: result.indexed,
                matched: result.matched,
                total: result.total,
                diagnostics: {
                  local_repo_path: localRepoPath || "not configured",
                  github_repo_url: githubRepoUrl || "not configured",
                  local_repo_exists: localRepoPath ? (await import("fs")).existsSync(localRepoPath) : false,
                  repo_path_source: repoPathSource,
                },
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        throw new Error(`Failed to index code for features: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "analyze_code_ownership": {
      const { force = false, since, calculate_feature_ownership = true } = args as {
        force?: boolean;
        since?: string;
        calculate_feature_ownership?: boolean;
      };

      try {
        const { analyzeCodeOwnership, calculateFeatureOwnership } = await import("../analysis/codeOwnership.js");
        
        console.error("[CodeOwnership] Starting code ownership analysis...");
        const result = await analyzeCodeOwnership(force, since);
        
        if (calculate_feature_ownership) {
          console.error("[CodeOwnership] Calculating feature-level ownership...");
          await calculateFeatureOwnership();
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "Code ownership analysis complete",
                files_analyzed: result.filesAnalyzed,
                engineers_found: result.engineersFound,
                feature_ownership_calculated: calculate_feature_ownership,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("Code ownership analysis failed:", error);
        throw new Error(`Code ownership analysis failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "view_feature_ownership": {
      const { format = "table" } = args as {
        format?: "table" | "json";
      };

      try {
        const { getAllFeatureOwnership, formatFeatureOwnershipTable } = await import("../analysis/codeOwnership.js");
        
        if (format === "json") {
          const data = await getAllFeatureOwnership();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  features: data,
                }, null, 2),
              },
            ],
          };
        } else {
          const table = await formatFeatureOwnershipTable();
          return {
            content: [
              {
                type: "text",
                text: table,
              },
            ],
          };
        }
      } catch (error) {
        logError("Failed to view feature ownership:", error);
        throw new Error(`Failed to view feature ownership: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // ========================================================================
    // PR Fix Tools - Learning and Fix Generation
    // ========================================================================

    case "seed_pr_learnings": {
      const { repo, since, limit, dry_run = false, batch_size = 50 } = args as {
        repo?: string;
        since?: string;
        limit?: number;
        dry_run?: boolean;
        batch_size?: number;
      };

      try {
        const { seedPRLearnings } = await import("../learning/prLearning.js");
        
        console.error("[PRLearning] Starting seed_pr_learnings...");
        const result = await seedPRLearnings({
          repo,
          since,
          limit,
          dryRun: dry_run,
          batchSize: batch_size,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: dry_run ? "Dry run complete" : "Seeding complete",
                total_issues_found: result.totalIssuesFound,
                issues_with_prs: result.issuesWithPRs,
                pr_learnings_created: result.prLearningsCreated,
                pr_learnings_skipped: result.prLearningsSkipped,
                errors_count: result.errors.length,
                errors: result.errors.slice(0, 10), // Show first 10 errors
                time_elapsed_seconds: Math.round(result.timeElapsed / 1000),
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("seed_pr_learnings failed:", error);
        throw new Error(`seed_pr_learnings failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "learn_from_pr": {
      const { repo, pr_number, force = false } = args as {
        repo?: string;
        pr_number: number;
        force?: boolean;
      };

      if (!pr_number) {
        throw new Error("pr_number is required");
      }

      try {
        const { learnFromPR } = await import("../learning/prLearning.js");
        
        console.error(`[PRLearning] Learning from PR #${pr_number}...`);
        const created = await learnFromPR(pr_number, force, repo);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                pr_number,
                learning_created: created,
                message: created 
                  ? `Successfully learned from PR #${pr_number}` 
                  : `PR #${pr_number} was already processed or has no linked issues`,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("learn_from_pr failed:", error);
        throw new Error(`learn_from_pr failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "investigate_issue": {
      const { issue_number, repo, include_discord = true, max_similar_fixes = 5 } = args as {
        issue_number: number;
        repo?: string;
        include_discord?: boolean;
        max_similar_fixes?: number;
      };

      if (!issue_number) {
        throw new Error("issue_number is required");
      }

      try {
        const { investigateIssue } = await import("../learning/investigateIssue.js");
        
        console.error(`[Investigate] Investigating issue #${issue_number}...`);
        const result = await investigateIssue({
          issueNumber: issue_number,
          repo,
          includeDiscord: include_discord,
          maxSimilarFixes: max_similar_fixes,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                issue_number,
                issue_title: result.issueContext.title,
                issue_url: result.issueContext.url,
                issue_state: result.issueContext.state,
                triage: {
                  result: result.triage.result,
                  confidence: result.triage.confidence,
                  reasoning: result.triage.reasoning,
                },
                similar_fixes_count: result.similarFixes.length,
                similar_fixes: result.similarFixes.map(f => ({
                  issue: `#${f.issueNumber}`,
                  pr: `#${f.prNumber}`,
                  pr_url: f.prUrl,
                  similarity: f.similarity.toFixed(3),
                  fix_patterns: f.fixPatterns,
                  files_changed: f.prFilesChanged.slice(0, 5),
                })),
                recommendation: result.recommendation,
                should_attempt_fix: result.shouldAttemptFix,
                already_investigated: result.alreadyInvestigated,
                // Include context for fix generation
                context: {
                  title: result.issueContext.title,
                  body: result.issueContext.body?.substring(0, 2000),
                  labels: result.issueContext.labels,
                  author: result.issueContext.author,
                  comments_count: result.issueContext.comments.length,
                  latest_comments: result.issueContext.comments.slice(-3).map(c => ({
                    author: c.author,
                    body: c.body.substring(0, 500),
                    is_org_member: c.isOrganizationMember,
                  })),
                  discord_threads: result.issueContext.discordThreads?.slice(0, 3),
                },
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("investigate_issue failed:", error);
        throw new Error(`investigate_issue failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "get_agent_briefing": {
      try {
        const { hasDatabaseConfig } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for agent briefings. Please configure DATABASE_URL.");
        }

        const { distillBriefingWithSessions, estimateTokenSavings } = await import("../briefing/distill.js");
        const { getLastSession, closeStaleSessions } = await import("../briefing/sessions.js");

        const scope = args?.scope as string | undefined;
        const since = args?.since as string | undefined;
        const project = args?.project as string | undefined;
        const projectId = project ?? detectProjectId();

        const staleClosed = await closeStaleSessions(projectId);

        console.error(`[Briefing] Generating agent briefing for project "${projectId}"${scope ? ` (scope: ${scope})` : ""}...`);

        // Self-heal: if the embedding provider is back up, embed any memories
        // that were saved while it was down (background, debounced).
        const { scheduleMemoryEmbeddingBackfill } = await import("../storage/db/memory.js");
        scheduleMemoryEmbeddingBackfill();

        const { briefing, sessions } = await distillBriefingWithSessions({ scope, since, project: projectId });
        const lastSession = await getLastSession(projectId);
        const tokenSavings = estimateTokenSavings(briefing, sessions);
        const embeddingProviderWarning = await getEmbeddingProviderWarning();

        const result = {
          briefing,
          lastSession: lastSession
            ? {
                sessionId: lastSession.sessionId,
                endedAt: lastSession.endedAt,
                scope: lastSession.scope,
                summary: lastSession.summary,
                openItems: lastSession.openItems,
                ...(lastSession.planSteps && lastSession.planSteps.length > 0 && { planSteps: lastSession.planSteps }),
              }
            : null,
          tokenSavings,
          ...(staleClosed > 0 && { staleSessionsClosed: staleClosed }),
          ...(embeddingProviderWarning && { embeddingProviderWarning }),
        };

        console.error(
          `[Briefing] Generated briefing: ${briefing.activeIssues.length} issues, ${briefing.userSignals.length} signals, ${briefing.decisions.length} decisions; ~${tokenSavings.estimatedSavedTokens} tokens saved (ratio ${tokenSavings.compressionRatio})${staleClosed ? `, ${staleClosed} stale session(s) auto-closed` : ""}`,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("get_agent_briefing failed:", error);
        throw new Error(`get_agent_briefing failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "start_agent_session": {
      try {
        const { hasDatabaseConfig } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for session tracking. Please configure DATABASE_URL.");
        }

        const { startSession } = await import("../briefing/sessions.js");
        const scope = (args?.scope as string[] | undefined) ?? [];
        const project = args?.project as string | undefined;
        const projectId = project ?? detectProjectId();

        console.error(`[Session] Starting new agent session for project "${projectId}" (scope: ${scope.join(", ") || "none"})...`);
        const session = await startSession(scope, projectId);
        console.error(`[Session] Started session: ${session.sessionId}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(session, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("start_agent_session failed:", error);
        throw new Error(`start_agent_session failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "end_agent_session": {
      try {
        const { hasDatabaseConfig } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for session tracking. Please configure DATABASE_URL.");
        }

        const { endSession } = await import("../briefing/sessions.js");
        const sessionId = args?.session_id as string;
        if (!sessionId) throw new Error("session_id is required");

        const relatedInsights = Array.isArray(args?.related_insights)
          ? (args.related_insights as unknown[]).filter(
              (s): s is string => typeof s === "string" && s.trim().length > 0,
            )
          : undefined;

        console.error(
          `[Session] Ending session: ${sessionId} (related_insights=${relatedInsights?.length ?? 0})...`,
        );
        const session = await endSession(sessionId, {
          filesEdited: args?.files_edited as string[] | undefined,
          decisionsMade: args?.decisions_made as string[] | undefined,
          openItems: args?.open_items as string[] | undefined,
          issuesReferenced: args?.issues_referenced as string[] | undefined,
          toolsUsed: args?.tools_used as string[] | undefined,
          planSteps: args?.plan_steps as import("../briefing/types.js").PlanStep[] | undefined,
          summary: args?.summary as string | undefined,
          relatedInsights,
        });
        console.error(`[Session] Ended session: ${sessionId}`);

        // Insights are embedded best-effort; if the provider is down they
        // land as text-only rows, so tell the agent to surface that.
        const embeddingProviderWarning =
          relatedInsights && relatedInsights.length > 0
            ? await getEmbeddingProviderWarning()
            : undefined;

        // Quantify the payoff of saving this session: distill the briefing
        // the *next* agent will receive (now including this record) and
        // estimate the compression. Best-effort — never fails the save.
        let tokenSavings: import("../briefing/distill.js").TokenSavings | undefined;
        let tokenSavingsNote: string | undefined;
        try {
          const { distillBriefingWithSessions, estimateTokenSavings } = await import(
            "../briefing/distill.js"
          );
          const { briefing, sessions } = await distillBriefingWithSessions({
            project: session.projectId,
          });
          tokenSavings = estimateTokenSavings(briefing, sessions);
          // A young project can have less recorded history than the briefing's
          // fixed overhead (structure, memories, activity scaffolding) — that's
          // not a failure, savings just haven't compounded yet. Say so instead
          // of reporting a discouraging "~0 tokens saved".
          tokenSavingsNote =
            tokenSavings.estimatedSavedTokens > 0
              ? `Session saved. Future agents get ~${tokenSavings.estimatedSourceTokens} tokens of accumulated ` +
                `session context distilled into a ~${tokenSavings.briefingTokens}-token briefing ` +
                `(${tokenSavings.compressionRatio}) — ~${tokenSavings.estimatedSavedTokens} tokens saved at every ` +
                `session start. Relay this to the user.`
              : `Session saved. This project has ~${tokenSavings.estimatedSourceTokens} tokens of recorded session ` +
                `history so far — still less than the ~${tokenSavings.briefingTokens}-token briefing (which carries ` +
                `fixed structure, memories, and activity context). No net savings yet: the briefing's size stays ` +
                `roughly flat while history grows, so savings compound after a few more recorded sessions. ` +
                `Relay this to the user.`;
        } catch (err) {
          console.error(
            "[Session] token-savings estimate failed (save unaffected):",
            err instanceof Error ? err.message : err,
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...session,
                  relatedInsightsSaved: relatedInsights?.length ?? 0,
                  ...(tokenSavings && { tokenSavings }),
                  ...(tokenSavingsNote && { tokenSavingsNote }),
                  ...(embeddingProviderWarning && { embeddingProviderWarning }),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        logError("end_agent_session failed:", error);
        throw new Error(`end_agent_session failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "update_agent_session": {
      try {
        const { hasDatabaseConfig } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for session tracking. Please configure DATABASE_URL.");
        }

        const { updateSession, SessionAmendmentExpiredError } = await import(
          "../briefing/sessions.js"
        );
        const sessionId = args?.session_id as string;
        if (!sessionId) throw new Error("session_id is required");

        console.error(`[Session] Updating session: ${sessionId}...`);
        try {
          const session = await updateSession(sessionId, {
            scope: args?.scope as string[] | undefined,
            filesEdited: args?.files_edited as string[] | undefined,
            decisionsMade: args?.decisions_made as string[] | undefined,
            openItems: args?.open_items as string[] | undefined,
            issuesReferenced: args?.issues_referenced as string[] | undefined,
            toolsUsed: args?.tools_used as string[] | undefined,
            planSteps: args?.plan_steps as import("../briefing/types.js").PlanStep[] | undefined,
            summary: args?.summary as string | undefined,
          });
          console.error(`[Session] Updated session: ${sessionId}`);
          return {
            content: [{ type: "text", text: JSON.stringify(session, null, 2) }],
          };
        } catch (err) {
          // Soft-end: if the amendment window has expired, surface a clear
          // message naming the env var so the operator knows how to extend
          // it (or to start a new session).
          if (err instanceof SessionAmendmentExpiredError) {
            throw new Error(
              `${err.message} (Adjust OPENBRIEFING_SESSION_AMEND_WINDOW_MS to change the window.)`,
            );
          }
          throw err;
        }
      } catch (error) {
        logError("update_agent_session failed:", error);
        throw new Error(`update_agent_session failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "get_session_history": {
      try {
        const { hasDatabaseConfig } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for session history. Please configure DATABASE_URL.");
        }

        const { getRecentSessions, getSession, summarizeSession } = await import("../briefing/sessions.js");
        const sessionId = args?.session_id as string | undefined;
        const verbose = (args?.verbose as boolean | undefined) ?? false;
        const requestedLimit = (args?.limit as number | undefined) ?? 5;
        const maxLimit = verbose ? 10 : 50;
        const limit = Math.max(1, Math.min(requestedLimit, maxLimit));
        const project = args?.project as string | undefined;
        const projectId = project ?? detectProjectId();

        if (sessionId) {
          console.error(`[Session] Fetching session: ${sessionId}...`);
          const session = await getSession(sessionId);
          if (!session) throw new Error(`Session not found: ${sessionId}`);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(session, null, 2),
              },
            ],
          };
        }

        console.error(
          `[Session] Fetching last ${limit} sessions for project "${projectId}" (verbose=${verbose})...`,
        );
        const sessions = await getRecentSessions(limit, projectId);
        console.error(`[Session] Found ${sessions.length} sessions`);

        const payload = verbose
          ? { sessions, count: sessions.length, mode: "verbose" }
          : {
              sessions: sessions.map(summarizeSession),
              count: sessions.length,
              mode: "compact",
              hint: "Pass verbose:true or session_id for full session details. Compact mode replaces arrays with counts and previews.",
            };

        if (requestedLimit !== limit) {
          (payload as Record<string, unknown>).limitCappedFrom = requestedLimit;
          (payload as Record<string, unknown>).limitApplied = limit;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("get_session_history failed:", error);
        throw new Error(`get_session_history failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "get_session_delta": {
      try {
        const { hasDatabaseConfig } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for session delta. Please configure DATABASE_URL.");
        }

        const since = args?.since;
        if (typeof since !== "string" || since.trim().length === 0) {
          throw new Error("`since` is required (sessionId, ISO timestamp, or any Date-parseable string).");
        }

        const { getSessionDelta } = await import("../briefing/sessions.js");
        const project = resolveProjectArg(args) ?? detectProjectId();
        const scope = typeof args?.scope === "string" ? args.scope : undefined;

        console.error(`[Session] Computing delta for project "${project}" since "${since}"...`);
        const delta = await getSessionDelta({
          projectId: project,
          since,
          scope,
        });
        console.error(
          `[Session] Delta: ${delta.changedSessions} session(s), ${delta.newDecisions.length} decisions, ` +
            `${delta.completedPlanSteps.length} completed steps, ${delta.newExternalRefs.length} refs`,
        );

        return {
          content: [{ type: "text", text: JSON.stringify(delta, null, 2) }],
        };
      } catch (error) {
        logError("get_session_delta failed:", error);
        throw new Error(`get_session_delta failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "link_external_event": {
      try {
        const { hasDatabaseConfig } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for session tracking. Please configure DATABASE_URL.");
        }

        const source = args?.source as string | undefined;
        const url = args?.url as string | undefined;
        const text = args?.text as string | undefined;
        if (!source || !url || !text) {
          throw new Error("`source`, `url`, and `text` are required for link_external_event.");
        }

        const { appendExternalRef, findActiveSessionForProject } = await import(
          "../briefing/sessions.js"
        );

        const explicitSessionId = args?.session_id as string | undefined;
        let targetSessionId = explicitSessionId;
        if (!targetSessionId) {
          const project = resolveProjectArg(args) ?? detectProjectId();
          const active = await findActiveSessionForProject(project);
          if (!active) {
            throw new Error(
              `No active or recently-amendable session for project "${project}". ` +
                `Call start_agent_session first, or pass session_id explicitly.`,
            );
          }
          targetSessionId = active.sessionId;
        }

        const role = (args?.kind as string | undefined) ?? "reference";
        if (!["decision", "open_item", "reference"].includes(role)) {
          throw new Error(`Invalid kind: ${role}. Expected one of decision|open_item|reference.`);
        }

        const ref = buildExternalRef({
          source,
          url,
          text,
          role: role as "decision" | "open_item" | "reference",
          channel: args?.channel as string | undefined,
          ts: args?.ts as string | undefined,
          pageId: args?.page_id as string | undefined,
          repo: args?.repo as string | undefined,
          number: typeof args?.number === "number" ? args.number : undefined,
          identifier: args?.identifier as string | undefined,
          path: args?.path as string | undefined,
          sha: args?.sha as string | undefined,
          guildId: args?.guild_id as string | undefined,
          threadId: args?.thread_id as string | undefined,
        });

        console.error(
          `[Session] Linking ${ref.kind} ref to session ${targetSessionId}: ${ref.text}`,
        );
        const session = await appendExternalRef(targetSessionId, ref);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sessionId: session.sessionId,
                  externalRefs: session.externalRefs ?? [],
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        logError("link_external_event failed:", error);
        throw new Error(`link_external_event failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "import_claude_plans": {
      try {
        const { readdir, readFile, stat } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");

        const plansDir = join(homedir(), ".claude", "plans");

        try {
          await stat(plansDir);
        } catch {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: "No Claude Code plans directory found at ~/.claude/plans/. Claude Code may not be installed or has no saved plans." }),
            }],
          };
        }

        const planFile = args?.plan_file as string | undefined;

        if (!planFile) {
          const files = await readdir(plansDir);
          const mdFiles = files.filter((f: string) => f.endsWith(".md"));

          const plans = await Promise.all(
            mdFiles.map(async (f: string) => {
              const fileStat = await stat(join(plansDir, f));
              const content = await readFile(join(plansDir, f), "utf-8");
              const titleMatch = content.match(/^#\s+(.+)/m);
              return {
                filename: f,
                title: titleMatch?.[1] ?? f.replace(".md", ""),
                lastModified: fileStat.mtime.toISOString(),
                sizeBytes: fileStat.size,
              };
            }),
          );

          plans.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                plans,
                hint: "Pass a filename as plan_file to import a specific plan. Pass session_id to attach it to your current session.",
              }, null, 2),
            }],
          };
        }

        const filePath = join(plansDir, planFile);
        const content = await readFile(filePath, "utf-8");

        const steps = parseMarkdownPlanSteps(content);
        const titleMatch = content.match(/^#\s+(.+)/m);
        const title = titleMatch?.[1] ?? planFile.replace(".md", "");

        const sessionId = args?.session_id as string | undefined;

        if (sessionId) {
          const { hasDatabaseConfig } = await import("../storage/factory.js");
          if (!hasDatabaseConfig()) {
            throw new Error("Database is required for session tracking. Please configure DATABASE_URL.");
          }
          const { updateSession } = await import("../briefing/sessions.js");

          console.error(`[Plans] Importing Claude Code plan "${title}" (${steps.length} steps) into session ${sessionId}...`);
          await updateSession(sessionId, {
            planSteps: steps,
            decisionsMade: [`Imported plan from Claude Code: ${title}`],
          });
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              title,
              filename: planFile,
              steps,
              totalSteps: steps.length,
              ...(sessionId && { attachedToSession: sessionId }),
            }, null, 2),
          }],
        };
      } catch (error) {
        logError("import_claude_plans failed:", error);
        throw new Error(`import_claude_plans failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // ==================================================================
    // X/Twitter Signal Source Handlers
    // ==================================================================

    case "save_memory": {
      const { saveMemory, scheduleMemoryEmbeddingBackfill } = await import("../storage/db/memory.js");
      scheduleMemoryEmbeddingBackfill();
      const entry = await saveMemory({
        content: String(args?.content ?? ""),
        summary: String(args?.summary ?? ""),
        tags: Array.isArray(args?.tags) ? args.tags as string[] : [],
        source: "conversation",
        projectId: resolveProjectArg(args),
      });
      // Only probe (and warn) when the embedding actually failed to land.
      const embeddingProviderWarning =
        entry.embedded === false ? await getEmbeddingProviderWarning() : undefined;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            memory: entry,
            ...(embeddingProviderWarning && { embeddingProviderWarning }),
          }, null, 2),
        }],
      };
    }

    case "search_memory": {
      const { searchMemory, scheduleMemoryEmbeddingBackfill } = await import("../storage/db/memory.js");
      scheduleMemoryEmbeddingBackfill();
      const results = await searchMemory({
        query: String(args?.query ?? ""),
        limit: typeof args?.limit === "number" ? args.limit : 5,
        tags: Array.isArray(args?.tags) ? args.tags as string[] : undefined,
        projectId: resolveProjectArg(args),
      });
      const embeddingProviderWarning = await getEmbeddingProviderWarning();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            results,
            count: results.length,
            ...(embeddingProviderWarning && {
              embeddingProviderWarning,
              searchMode: "keyword-fallback",
            }),
          }, null, 2),
        }],
      };
    }

    case "get_recent_memories": {
      const { getRecentMemories } = await import("../storage/db/memory.js");
      const results = await getRecentMemories({
        limit: typeof args?.limit === "number" ? args.limit : 10,
        tags: Array.isArray(args?.tags) ? args.tags as string[] : undefined,
        projectId: resolveProjectArg(args),
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ results, count: results.length }, null, 2),
        }],
      };
    }

    case "delete_memory": {
      const { deleteMemory } = await import("../storage/db/memory.js");
      const ok = await deleteMemory(String(args?.id ?? ""));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: ok }, null, 2),
        }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    // Catch and format errors properly for MCP client
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Check if it's a JSON parsing error and provide more context
    if (errorMessage.includes("Unexpected token")) {
      logError("JSON parsing error:", error);
      throw new Error(`Invalid JSON data encountered: ${errorMessage}. This may indicate a corrupted or invalid file.`);
    }
    
    // Log the error for debugging
    logError(`Error handling command: ${name}`, error);
    
    // Re-throw with formatted message
    throw new Error(`Command failed: ${errorMessage}`);
  }
});

/**
 * Probe the embedding provider and return an agent-facing warning when it's
 * unreachable. Returned (as `embeddingProviderWarning`) by the briefing and
 * memory tools so agents can tell the human to start Ollama instead of
 * silently degrading to keyword search / unembedded writes. `undefined` when
 * the provider is healthy.
 */
async function getEmbeddingProviderWarning(): Promise<string | undefined> {
  const { isEmbeddingProviderAvailable, describeEmbeddingProvider } = await import(
    "../embeddings/embed.js"
  );
  if (await isEmbeddingProviderAvailable()) return undefined;
  return (
    `Embedding provider ${describeEmbeddingProvider()} is unreachable. ` +
    `Semantic memory search and relatedInsights are degraded, and new memories are saved WITHOUT embeddings. ` +
    `ACTION: ask the user to start Ollama (open the Ollama app or run \`ollama serve\`). ` +
    `Once it's running, missing embeddings are backfilled automatically on the next briefing/memory call.`
  );
}

/**
 * Parse a Claude Code markdown plan into structured PlanStep objects.
 * Looks for numbered/bulleted items under headings containing "step", "file", or "implementation",
 * and falls back to extracting all top-level headings as steps.
 */
function parseMarkdownPlanSteps(markdown: string): import("../briefing/types.js").PlanStep[] {
  const steps: import("../briefing/types.js").PlanStep[] = [];

  const stepSectionRegex = /^###?\s+(?:Step\s+)?(\d+)[.:]\s*(.+)/gim;
  let match;
  while ((match = stepSectionRegex.exec(markdown)) !== null) {
    steps.push({
      id: match[1],
      description: match[2].trim(),
      status: "pending",
    });
  }

  if (steps.length > 0) return steps;

  const headingRegex = /^###?\s+(?:\d+\.\s+)?(?:(?:Modify|New file|Create|Update|Add|Fix|Remove|Refactor):\s*)?(.+)/gim;
  let stepNum = 0;
  while ((match = headingRegex.exec(markdown)) !== null) {
    const desc = match[1].trim();
    if (desc.toLowerCase() === "overview" || desc.toLowerCase() === "context" || desc.toLowerCase() === "verification") continue;
    stepNum++;
    steps.push({
      id: String(stepNum),
      description: desc,
      status: "pending",
    });
  }

  return steps;
}

// Start the server
async function main() {
  const projectId = detectProjectId();
  console.error(`[OpenBriefing] Project: ${projectId}`);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((error) => {
  logError("Failed to start server:", error);
  process.exit(1);
});
