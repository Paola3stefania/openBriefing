/**
 * Daily sync cron job endpoint
 * Called by Vercel Cron at scheduled intervals
 * 
 * Full workflow:
 * 1. Sync Discord messages (incremental)
 * 2. Sync GitHub issues (incremental)
 * 3. Classify Discord threads
 * 4. Group GitHub issues
 * 5. Match issues to threads
 * 6. Match issues to features
 * 7. Label issues
 * 8. Export to Linear
 * 
 * Authentication: CRON_SECRET (Vercel injects this automatically)
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyCronSecret, sendUnauthorized, sendSuccess, sendError } from "../lib/middleware.js";
import { executeToolHandler, cleanupToolExecutor } from "../lib/tool-executor.js";

export const config = {
  maxDuration: 60, // Vercel Pro: 60 seconds
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only allow GET and POST
  if (req.method !== "GET" && req.method !== "POST") {
    return sendError(res, "Method not allowed", 405);
  }

  // Verify cron secret
  const auth = verifyCronSecret(req);
  if (!auth.valid) {
    console.error("[Cron] Unauthorized:", auth.error);
    return sendUnauthorized(res, auth.error || "Unauthorized");
  }

  console.log("[Cron] Starting daily sync workflow...");
  const startTime = Date.now();
  const results: Record<string, unknown> = {};

  try {
    const channelId = process.env.DISCORD_DEFAULT_CHANNEL_ID;
    
    // Step 1: Sync Discord messages
    console.log("[Cron] Step 1/8: Syncing Discord messages...");
    results.discord = await executeToolHandler("fetch_discord_messages", { 
      channel_id: channelId, 
      incremental: true 
    });

    // Step 2: Sync GitHub issues
    console.log("[Cron] Step 2/8: Syncing GitHub issues...");
    results.github = await executeToolHandler("fetch_github_issues", { 
      incremental: true 
    });

    // Step 3: Classify Discord threads
    console.log("[Cron] Step 3/8: Classifying Discord threads...");
    results.classification = await executeToolHandler("classify_discord_messages", { 
      channel_id: channelId,
      min_similarity: 20
    });

    // Step 4: Compute embeddings (needed for grouping/matching)
    console.log("[Cron] Step 4/8: Computing embeddings...");
    results.embeddings = {
      issues: await executeToolHandler("compute_github_issue_embeddings", {}),
      threads: await executeToolHandler("compute_discord_embeddings", {}),
    };

    // Step 5: Group GitHub issues
    console.log("[Cron] Step 5/8: Grouping GitHub issues...");
    results.grouping = await executeToolHandler("group_github_issues", { 
      min_similarity: 80 
    });

    // Step 6: Match issues to threads
    console.log("[Cron] Step 6/8: Matching issues to threads...");
    results.thread_matching = await executeToolHandler("match_issues_to_threads", { 
      min_similarity: 50 
    });

    // Step 7: Label issues
    console.log("[Cron] Step 7/8: Labeling issues...");
    results.labeling = await executeToolHandler("label_github_issues", {});

    // Step 8: Export to Linear
    console.log("[Cron] Step 8/8: Exporting to Linear...");
    results.export = await executeToolHandler("export_to_pm_tool", { 
      channel_id: channelId 
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Cron] Workflow completed in ${duration}s`);

    return sendSuccess(res, {
      message: `Daily sync completed in ${duration}s`,
      steps: results,
      duration_seconds: parseFloat(duration),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Cron] Error:", error);
    return sendError(
      res,
      error instanceof Error ? error.message : "Internal server error"
    );
  } finally {
    await cleanupToolExecutor();
  }
}

