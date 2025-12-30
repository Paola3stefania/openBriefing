/**
 * Manual sync endpoint - convenience wrapper for sync_and_classify tool
 * 
 * POST /api/mcp/sync
 * { "channel_id": "optional" }
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
      endpoint: "sync",
      description: "Sync Discord + GitHub + Classify (convenience endpoint)",
      note: "For more control, use POST /api/mcp/tool with individual tools",
    });
  }

  if (req.method !== "POST") {
    return sendError(res, "Method not allowed", 405);
  }

  const body = req.body || {};
  const startTime = Date.now();

  try {
    const result = await executeToolHandler("sync_and_classify", {
      channel_id: body.channel_id,
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    return sendSuccess(res, {
      message: `Sync completed in ${duration}s`,
      ...result as object,
      duration_seconds: parseFloat(duration),
    });
  } catch (error) {
    return sendError(res, error instanceof Error ? error.message : "Sync failed");
  } finally {
    await cleanupToolExecutor();
  }
}

