/**
 * Status endpoint - health check and statistics
 * 
 * GET /api/mcp/status
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyApiKey, sendUnauthorized, sendSuccess, sendError } from "../lib/middleware.js";
import { PrismaClient } from "@prisma/client";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return sendError(res, "Method not allowed", 405);
  }

  const auth = verifyApiKey(req);
  if (!auth.valid) {
    return sendUnauthorized(res, auth.error || "Unauthorized");
  }

  const prisma = new PrismaClient();

  try {
    const [
      discordCount,
      issueCount,
      openCount,
      classifiedCount,
      matchedCount,
      exportedCount,
      lastMsg,
      lastIssue,
    ] = await Promise.all([
      prisma.discordMessage.count(),
      prisma.gitHubIssue.count(),
      prisma.gitHubIssue.count({ where: { issueState: "open" } }),
      prisma.classifiedThread.count(),
      prisma.classifiedThread.count({ where: { matchStatus: "matched" } }),
      prisma.gitHubIssue.count({ where: { exportStatus: "exported" } }),
      prisma.discordMessage.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      prisma.gitHubIssue.findFirst({ orderBy: { issueUpdatedAt: "desc" }, select: { issueUpdatedAt: true } }),
    ]);

    return sendSuccess(res, {
      status: "healthy",
      statistics: {
        discord: { total: discordCount, last_at: lastMsg?.createdAt?.toISOString() },
        github: { total: issueCount, open: openCount, last_at: lastIssue?.issueUpdatedAt?.toISOString() },
        classification: { total: classifiedCount, matched: matchedCount },
        export: { exported: exportedCount },
      },
    });
  } catch (error) {
    return sendError(res, error instanceof Error ? error.message : "Status check failed");
  } finally {
    await prisma.$disconnect();
  }
}

