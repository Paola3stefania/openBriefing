/**
 * Generic tool execution endpoint
 * Allows calling any MCP tool via HTTP
 * 
 * POST /api/mcp/tool
 * {
 *   "tool": "tool_name",
 *   "args": { ... }
 * }
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyApiKey, sendUnauthorized, sendSuccess, sendError } from "../lib/middleware.js";
import { executeToolHandler, getAvailableTools, cleanupToolExecutor } from "../lib/tool-executor.js";

export const config = {
  maxDuration: 60, // Vercel Pro: 60 seconds
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify API key
  const auth = verifyApiKey(req);
  if (!auth.valid) {
    console.error("[MCP Tool] Unauthorized:", auth.error);
    return sendUnauthorized(res, auth.error || "Unauthorized");
  }

  if (req.method === "GET") {
    // Return list of available tools
    const tools = getAvailableTools();
    return sendSuccess(res, {
      endpoint: "tool",
      description: "Execute any MCP tool via HTTP",
      usage: {
        method: "POST",
        body: {
          tool: "tool_name",
          args: "{ ... tool arguments ... }"
        }
      },
      available_tools: tools,
    });
  }

  if (req.method !== "POST") {
    return sendError(res, "Method not allowed", 405);
  }

  // Parse request body
  const body = req.body || {};
  const { tool, args = {} } = body as { tool?: string; args?: Record<string, unknown> };

  if (!tool) {
    return sendError(res, "Missing 'tool' in request body", 400);
  }

  console.log(`[MCP Tool] Executing tool: ${tool}`);
  const startTime = Date.now();

  try {
    const result = await executeToolHandler(tool, args);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`[MCP Tool] ${tool} completed in ${duration}s`);

    return sendSuccess(res, {
      tool,
      result,
      duration_seconds: parseFloat(duration),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[MCP Tool] Error executing ${tool}:`, error);
    return sendError(
      res,
      error instanceof Error ? error.message : `Failed to execute tool: ${tool}`
    );
  } finally {
    await cleanupToolExecutor();
  }
}

