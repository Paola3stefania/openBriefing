/**
 * Base interface for PM tool integrations
 * All PM tool integrations should implement this interface
 */

import { PMToolIssue, PMToolConfig, ExportResult } from "./types.js";

export interface IPMTool {
  /**
   * Create an issue in the PM tool
   */
  createIssue(issue: PMToolIssue): Promise<{ id: string; identifier?: string; url: string }>;

  /**
   * Update an existing issue
   */
  updateIssue(issueId: string, updates: Partial<PMToolIssue>): Promise<void>;

  /**
   * Check if an issue already exists (by source ID)
   * Note: Most PM tools don't support this natively - use stored mapping instead
   */
  findIssueBySourceId(sourceId: string): Promise<{ id: string; url: string } | null>;

  /**
   * Get issue details by ID (for reading status/updates)
   */
  getIssue?(issueId: string): Promise<{ id: string; identifier?: string; url: string; title: string; state: string } | null>;

  /**
   * Export multiple issues
   */
  exportIssues(issues: PMToolIssue[]): Promise<ExportResult>;
}

/**
 * Abstract base class for PM tool implementations
 */
export abstract class BasePMTool implements IPMTool {
  protected config: PMToolConfig;

  constructor(config: PMToolConfig) {
    this.config = config;
  }

  abstract createIssue(issue: PMToolIssue): Promise<{ id: string; identifier?: string; url: string }>;
  abstract updateIssue(issueId: string, updates: Partial<PMToolIssue>): Promise<void>;
  abstract findIssueBySourceId(sourceId: string): Promise<{ id: string; url: string } | null>;

  /**
   * Default implementation for exporting multiple issues
   * Can be overridden by specific implementations
   */
  async exportIssues(issues: PMToolIssue[]): Promise<ExportResult> {
    const result: ExportResult = {
      success: true,
      created_issues: 0,
      updated_issues: 0,
      skipped_issues: 0,
      errors: [],
      issue_urls: [],
    };

    for (const issue of issues) {
      try {
        // Check if issue already has a stored ID (from previous export)
        // If it does, verify it exists before using it
        let existing: { id: string; url: string } | null = null;
        
        if (issue.linear_issue_id) {
          // Verify the stored ID exists in Linear
          const linearTool = this as any;
          if (typeof linearTool.getIssue === "function") {
            const verifiedIssue = await linearTool.getIssue(issue.linear_issue_id);
            if (verifiedIssue) {
              existing = {
                id: verifiedIssue.id,
                url: verifiedIssue.url,
              };
            }
          }
        }
        
        // If no stored ID or verification failed, try finding by source ID
        // Pass title to enable title-based search fallback for duplicate detection
        if (!existing) {
          const linearTool = this as any;
          if (typeof linearTool.findIssueBySourceId === "function" && linearTool.findIssueBySourceId.length > 1) {
            // Linear implementation accepts title parameter
            existing = await linearTool.findIssueBySourceId(issue.source_id, issue.title);
          } else {
            // Other implementations only accept sourceId
            existing = await this.findIssueBySourceId(issue.source_id);
          }
        }
        
        if (existing) {
          // Update existing issue
          await this.updateIssue(existing.id, issue);
          result.updated_issues++;
          if (existing.url) {
            result.issue_urls?.push(existing.url);
          }
          // Ensure the issue object has the ID stored
          issue.linear_issue_id = existing.id;
        } else {
          // Create new issue
          const created = await this.createIssue(issue);
          result.created_issues++;
          result.issue_urls?.push(created.url);
          
          // Store Linear issue ID, identifier, and URL in the issue for mapping
          issue.linear_issue_id = created.id;
          if (created.identifier) {
            issue.linear_issue_identifier = created.identifier;
          }
          if (created.url) {
            (issue as any).linear_issue_url = created.url;
          }
        }
      } catch (error) {
        result.errors?.push({
          source_id: issue.source_id,
          error: error instanceof Error ? error.message : String(error),
        });
        result.skipped_issues++;
      }
    }

    return result;
  }
}

