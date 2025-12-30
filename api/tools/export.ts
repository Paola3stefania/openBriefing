/**
 * Manual export endpoint - convenience wrapper for export_to_pm_tool
 * 
 * POST /api/mcp/export
 * { "channel_id": "optional", "include_closed": false }
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyApiKey, sendUnauthorized, sendSuccess, sendError } from "../lib/middleware.js";
import { executeToolHandler, cleanupToolExecutor } from "../lib/tool-executor.js";

export const config = {
  maxDuration: 60,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = verifyApiKey(req);
  if (!auth.valid) {
    return sendUnauthorized(res, auth.error || "Unauthorized");
  }

  if (req.method === "GET") {
    return sendSuccess(res, {
      endpoint: "export",
      description: "Export to Linear (convenience endpoint)",
      note: "For more control, use POST /api/mcp/tool with export_to_pm_tool",
    });
  }

  if (req.method !== "POST") {
    return sendError(res, "Method not allowed", 405);
  }

  const body = req.body || {};
  const startTime = Date.now();

  try {
    const result = await executeToolHandler("export_to_pm_tool", {
      channel_id: body.channel_id,
      include_closed: body.include_closed,
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    return sendSuccess(res, {
      message: `Export completed in ${duration}s`,
      ...result as object,
      duration_seconds: parseFloat(duration),
    });
  } catch (error) {
    return sendError(res, error instanceof Error ? error.message : "Export failed");
  } finally {
    await cleanupToolExecutor();
  }
}

