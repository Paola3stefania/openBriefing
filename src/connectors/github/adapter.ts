/**
 * Adapter to convert GitHubIssue to Signal
 */
import type { GitHubIssue } from "./client.js";
import type { Signal } from "../../types/signal.js";

export function githubIssueToSignal(issue: GitHubIssue, owner: string, repo: string): Signal {
  return {
    source: "github",
    sourceId: issue.number.toString(),
    permalink: issue.html_url,
    title: issue.title,
    body: issue.body || "",
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    metadata: {
      id: issue.id,
      number: issue.number,
      state: issue.state,
      user: issue.user,
      labels: issue.labels,
      owner,
      repo,
    },
  };
}

export function githubIssuesToSignals(
  issues: GitHubIssue[],
  owner: string,
  repo: string
): Signal[] {
  return issues.map((issue) => githubIssueToSignal(issue, owner, repo));
}

