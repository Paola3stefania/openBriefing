/**
 * Correlation and grouping logic
 * Groups related signals (Discord messages, GitHub issues) together
 */
import type { Signal, GroupCandidate, IssueRef } from "../../types/signal.js";

export interface CorrelationOptions {
  minSimilarity?: number;
  maxGroups?: number;
}

/**
 * Group signals that are likely related to the same issue
 * Uses similarity scoring to identify potential duplicates or related items
 */
export function groupSignalsBySimilarity(
  signals: Signal[],
  options: CorrelationOptions = {}
): GroupCandidate[] {
  const { minSimilarity = 0.5, maxGroups = 10 } = options;
  const groups: GroupCandidate[] = [];
  const processed = new Set<string>();

  for (let i = 0; i < signals.length; i++) {
    if (processed.has(signals[i].sourceId)) continue;

    const group: Signal[] = [signals[i]];
    processed.add(signals[i].sourceId);

    // Find similar signals
    for (let j = i + 1; j < signals.length; j++) {
      if (processed.has(signals[j].sourceId)) continue;

      const similarity = calculateTextSimilarity(
        signals[i].body,
        signals[j].body,
        signals[i].title,
        signals[j].title
      );

      if (similarity >= minSimilarity) {
        group.push(signals[j]);
        processed.add(signals[j].sourceId);
      }
    }

    if (group.length > 1) {
      // Calculate average similarity for the group
      let totalSimilarity = 0;
      let comparisons = 0;
      for (let k = 0; k < group.length; k++) {
        for (let l = k + 1; l < group.length; l++) {
          totalSimilarity += calculateTextSimilarity(
            group[k].body,
            group[l].body,
            group[k].title,
            group[l].title
          );
          comparisons++;
        }
      }
      const avgSimilarity = comparisons > 0 ? totalSimilarity / comparisons : 0;

      // Find canonical issue (prefer GitHub issues, then most recent)
      const canonicalIssue = findCanonicalIssue(group);

      groups.push({
        signals: group,
        similarity: avgSimilarity,
        canonicalIssue,
      });
    }
  }

  // Sort by similarity and limit
  return groups
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxGroups);
}

/**
 * Calculate text similarity between two signals
 * Simple implementation using word overlap
 */
function calculateTextSimilarity(
  text1: string,
  text2: string,
  title1?: string,
  title2?: string
): number {
  const words1 = extractWords(text1 + " " + (title1 || ""));
  const words2 = extractWords(text2 + " " + (title2 || ""));

  if (words1.size === 0 && words2.size === 0) return 0;
  if (words1.size === 0 || words2.size === 0) return 0;

  let intersection = 0;
  for (const word of words1) {
    if (words2.has(word)) {
      intersection++;
    }
  }

  const union = words1.size + words2.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function extractWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

/**
 * Find the canonical issue from a group of signals
 * Prefers GitHub issues over Discord messages, then most recent
 */
function findCanonicalIssue(signals: Signal[]): IssueRef | undefined {
  // Prefer GitHub issues
  const githubIssues = signals.filter((s) => s.source === "github");
  if (githubIssues.length > 0) {
    const mostRecent = githubIssues.sort(
      (a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
    )[0];
    return {
      source: "github",
      sourceId: mostRecent.sourceId,
      permalink: mostRecent.permalink,
      title: mostRecent.title,
    };
  }

  // Fallback to most recent signal
  const mostRecent = signals.sort(
    (a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
  )[0];
  return {
    source: mostRecent.source,
    sourceId: mostRecent.sourceId,
    permalink: mostRecent.permalink,
    title: mostRecent.title,
  };
}

/**
 * Find duplicate signals (exact or near-duplicate content)
 */
export function findDuplicates(
  signals: Signal[],
  threshold: number = 0.9
): Signal[][] {
  const duplicates: Signal[][] = [];
  const processed = new Set<string>();

  for (let i = 0; i < signals.length; i++) {
    if (processed.has(signals[i].sourceId)) continue;

    const group: Signal[] = [signals[i]];
    processed.add(signals[i].sourceId);

    for (let j = i + 1; j < signals.length; j++) {
      if (processed.has(signals[j].sourceId)) continue;

      const similarity = calculateTextSimilarity(
        signals[i].body,
        signals[j].body,
        signals[i].title,
        signals[j].title
      );

      if (similarity >= threshold) {
        group.push(signals[j]);
        processed.add(signals[j].sourceId);
      }
    }

    if (group.length > 1) {
      duplicates.push(group);
    }
  }

  return duplicates;
}

