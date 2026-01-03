/**
 * PR-based sync endpoint
 * Syncs Linear issue status and assignee based on open PRs connected to GitHub issues
 * 
 * POST /api/tools/pr-sync
 * {
 *   "dry_run": false,
 *   "user_mappings": [{"githubUsername": "engineer1", "linearUserId": "linear-user-id"}],
 *   "organization_engineers": ["engineer1", "engineer2"],
 *   "default_assignee_id": "optional-linear-user-id"
 * }
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyApiKey, sendUnauthorized, sendSuccess, sendError } from "../lib/middleware.js";
import { syncPRBasedStatus } from "../../src/sync/prBasedSync.js";

export const config = {
  maxDuration: 300, // 5 minutes - PR checks can take time
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = verifyApiKey(req);
  if (!auth.valid) {
    return sendUnauthorized(res, auth.error || "Unauthorized");
  }

  if (req.method === "GET") {
    return sendSuccess(res, {
      endpoint: "pr-sync",
      description: "Sync Linear issue status and assignee based on open PRs",
      note: "Checks for open PRs connected to GitHub issues and updates Linear issues accordingly",
      parameters: {
        dry_run: "boolean - If true, shows what would be updated without making changes",
        user_mappings: "array - Organization engineer GitHub username to Linear user ID mappings",
        organization_engineers: "array - List of organization engineer GitHub usernames",
        default_assignee_id: "string - Default Linear user ID if PR author is organization engineer but no mapping found",
      },
    });
  }

  if (req.method !== "POST") {
    return sendError(res, "Method not allowed", 405);
  }

  const body = req.body || {};
  const startTime = Date.now();

  try {
    const result = await syncPRBasedStatus({
      dryRun: body.dry_run || false,
      userMappings: body.user_mappings,
      organizationEngineers: body.organization_engineers,
      defaultAssigneeId: body.default_assignee_id,
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    return sendSuccess(res, {
      message: `PR-based sync completed in ${duration}s`,
      ...result,
      duration_seconds: parseFloat(duration),
    });
  } catch (error) {
    return sendError(res, error instanceof Error ? error.message : "PR-based sync failed");
  }
}

