/**
 * PostgreSQL database storage implementation
 */

import type { IStorage } from "../interface.js";
import type { ClassifiedThread, Group, UngroupedThread, StorageStats } from "../types.js";
import type { DocumentationContent } from "../../export/documentationFetcher.js";
import { query, transaction } from "./client.js";

export class DatabaseStorage implements IStorage {
  async upsertChannel(channelId: string, channelName?: string, guildId?: string): Promise<void> {
    await query(
      `INSERT INTO channels (id, name, guild_id, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         guild_id = EXCLUDED.guild_id,
         updated_at = NOW()`,
      [channelId, channelName || null, guildId || null]
    );
  }

  async saveClassifiedThread(thread: ClassifiedThread): Promise<void> {
    await this.saveClassifiedThreads([thread]);
  }

  async saveClassifiedThreads(threads: ClassifiedThread[]): Promise<void> {
    if (threads.length === 0) return;

    await transaction(async (client) => {
      for (const thread of threads) {
        // Upsert thread
        await client.query(
          `INSERT INTO classified_threads (
            thread_id, channel_id, thread_name, message_count,
            first_message_id, first_message_author, first_message_timestamp, first_message_url,
            status, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
          ON CONFLICT (thread_id) DO UPDATE SET
            thread_name = EXCLUDED.thread_name,
            message_count = EXCLUDED.message_count,
            first_message_author = EXCLUDED.first_message_author,
            first_message_timestamp = EXCLUDED.first_message_timestamp,
            first_message_url = EXCLUDED.first_message_url,
            status = EXCLUDED.status,
            updated_at = NOW()`,
          [
            thread.thread_id,
            thread.channel_id,
            thread.thread_name || null,
            thread.message_count,
            thread.first_message_id,
            thread.first_message_author || null,
            thread.first_message_timestamp ? new Date(thread.first_message_timestamp) : null,
            thread.first_message_url || null,
            thread.status,
          ]
        );

        // Delete existing matches
        await client.query(
          `DELETE FROM thread_issue_matches WHERE thread_id = $1`,
          [thread.thread_id]
        );

        // Insert new matches
        for (const issue of thread.issues) {
          await client.query(
            `INSERT INTO thread_issue_matches (
              thread_id, issue_number, issue_title, issue_url, issue_state,
              similarity_score, issue_labels, issue_author, issue_created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (thread_id, issue_number) DO UPDATE SET
              similarity_score = EXCLUDED.similarity_score,
              issue_labels = EXCLUDED.issue_labels`,
            [
              thread.thread_id,
              issue.number,
              issue.title,
              issue.url,
              issue.state,
              issue.similarity_score,
              issue.labels || [],
              issue.author || null,
              issue.created_at ? new Date(issue.created_at) : null,
            ]
          );
        }
      }
    });
  }

  async getClassifiedThreads(channelId: string): Promise<ClassifiedThread[]> {
    const result = await query(
      `SELECT 
        ct.thread_id, ct.channel_id, ct.thread_name, ct.message_count,
        ct.first_message_id, ct.first_message_author, ct.first_message_timestamp, ct.first_message_url,
        ct.classified_at, ct.status,
        COALESCE(
          json_agg(
            json_build_object(
              'number', tim.issue_number,
              'title', tim.issue_title,
              'url', tim.issue_url,
              'state', tim.issue_state,
              'similarity_score', tim.similarity_score,
              'labels', tim.issue_labels,
              'author', tim.issue_author,
              'created_at', tim.issue_created_at
            ) ORDER BY tim.similarity_score DESC
          ) FILTER (WHERE tim.issue_number IS NOT NULL),
          '[]'::json
        ) as issues
       FROM classified_threads ct
       LEFT JOIN thread_issue_matches tim ON ct.thread_id = tim.thread_id
       WHERE ct.channel_id = $1
       GROUP BY ct.thread_id, ct.channel_id, ct.thread_name, ct.message_count,
                ct.first_message_id, ct.first_message_author, ct.first_message_timestamp,
                ct.first_message_url, ct.classified_at, ct.status
       ORDER BY ct.classified_at DESC`,
      [channelId]
    );

    return result.rows.map((row: any) => ({
      thread_id: row.thread_id,
      channel_id: row.channel_id,
      thread_name: row.thread_name,
      message_count: row.message_count,
      first_message_id: row.first_message_id,
      first_message_author: row.first_message_author,
      first_message_timestamp: row.first_message_timestamp?.toISOString(),
      first_message_url: row.first_message_url,
      classified_at: row.classified_at?.toISOString() || new Date().toISOString(),
      status: row.status,
      issues: row.issues || [],
    }));
  }

  async getClassifiedThread(threadId: string): Promise<ClassifiedThread | null> {
    const result = await query(
      `SELECT 
        ct.thread_id, ct.channel_id, ct.thread_name, ct.message_count,
        ct.first_message_id, ct.first_message_author, ct.first_message_timestamp, ct.first_message_url,
        ct.classified_at, ct.status,
        COALESCE(
          json_agg(
            json_build_object(
              'number', tim.issue_number,
              'title', tim.issue_title,
              'url', tim.issue_url,
              'state', tim.issue_state,
              'similarity_score', tim.similarity_score,
              'labels', tim.issue_labels,
              'author', tim.issue_author,
              'created_at', tim.issue_created_at
            ) ORDER BY tim.similarity_score DESC
          ) FILTER (WHERE tim.issue_number IS NOT NULL),
          '[]'::json
        ) as issues
       FROM classified_threads ct
       LEFT JOIN thread_issue_matches tim ON ct.thread_id = tim.thread_id
       WHERE ct.thread_id = $1
       GROUP BY ct.thread_id, ct.channel_id, ct.thread_name, ct.message_count,
                ct.first_message_id, ct.first_message_author, ct.first_message_timestamp,
                ct.first_message_url, ct.classified_at, ct.status`,
      [threadId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      thread_id: row.thread_id,
      channel_id: row.channel_id,
      thread_name: row.thread_name,
      message_count: row.message_count,
      first_message_id: row.first_message_id,
      first_message_author: row.first_message_author,
      first_message_timestamp: row.first_message_timestamp?.toISOString(),
      first_message_url: row.first_message_url,
      classified_at: row.classified_at?.toISOString() || new Date().toISOString(),
      status: row.status,
      issues: row.issues || [],
    };
  }

  async saveGroup(group: Group): Promise<void> {
    await this.saveGroups([group]);
  }

  async saveGroups(groups: Group[]): Promise<void> {
    if (groups.length === 0) return;

    await transaction(async (client) => {
      for (const group of groups) {
        // Upsert group
        await client.query(
          `INSERT INTO groups (
            id, channel_id, github_issue_number, suggested_title,
            avg_similarity, thread_count, is_cross_cutting, status,
            exported_at, linear_issue_id, linear_issue_url, linear_issue_identifier,
            linear_project_ids, affects_features, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
          ON CONFLICT (id) DO UPDATE SET
            suggested_title = EXCLUDED.suggested_title,
            avg_similarity = EXCLUDED.avg_similarity,
            thread_count = EXCLUDED.thread_count,
            is_cross_cutting = EXCLUDED.is_cross_cutting,
            status = EXCLUDED.status,
            exported_at = EXCLUDED.exported_at,
            linear_issue_id = EXCLUDED.linear_issue_id,
            linear_issue_url = EXCLUDED.linear_issue_url,
            linear_issue_identifier = EXCLUDED.linear_issue_identifier,
            linear_project_ids = EXCLUDED.linear_project_ids,
            affects_features = EXCLUDED.affects_features,
            updated_at = NOW()`,
          [
            group.id,
            group.channel_id,
            group.github_issue_number || null,
            group.suggested_title,
            group.avg_similarity,
            group.thread_count,
            group.is_cross_cutting,
            group.status,
            group.exported_at ? new Date(group.exported_at) : null,
            group.linear_issue_id || null,
            group.linear_issue_url || null,
            group.linear_issue_identifier || null,
            group.linear_project_ids || null,
            group.affects_features ? JSON.stringify(group.affects_features) : '[]',
          ]
        );

        // Delete existing group-thread relationships
        await client.query(
          `DELETE FROM group_threads WHERE group_id = $1`,
          [group.id]
        );

        // Insert group-thread relationships
        for (const thread of group.threads) {
          await client.query(
            `INSERT INTO group_threads (group_id, thread_id, similarity_score)
             VALUES ($1, $2, $3)
             ON CONFLICT (group_id, thread_id) DO UPDATE SET
               similarity_score = EXCLUDED.similarity_score`,
            [
              group.id,
              thread.thread_id,
              thread.similarity_score,
            ]
          );
        }
      }
    });
  }

  async getGroups(channelId: string, options?: { status?: "pending" | "exported" }): Promise<Group[]> {
    let queryText = `
      SELECT 
        g.id, g.channel_id, g.github_issue_number, g.suggested_title,
        g.avg_similarity, g.thread_count, g.is_cross_cutting, g.status,
        g.created_at, g.updated_at, g.exported_at,
        g.linear_issue_id, g.linear_issue_url, g.linear_issue_identifier,
        g.linear_project_ids, g.affects_features,
        COALESCE(
          json_agg(
            json_build_object(
              'thread_id', gt.thread_id,
              'thread_name', ct.thread_name,
              'similarity_score', gt.similarity_score,
              'url', ct.first_message_url,
              'author', ct.first_message_author,
              'timestamp', ct.first_message_timestamp
            ) ORDER BY gt.similarity_score DESC
          ) FILTER (WHERE gt.thread_id IS NOT NULL),
          '[]'::json
        ) as threads
      FROM groups g
      LEFT JOIN group_threads gt ON g.id = gt.group_id
      LEFT JOIN classified_threads ct ON gt.thread_id = ct.thread_id
      WHERE g.channel_id = $1
    `;

    const params: any[] = [channelId];

    if (options?.status) {
      queryText += ` AND g.status = $2`;
      params.push(options.status);
    }

    queryText += `
      GROUP BY g.id, g.channel_id, g.github_issue_number, g.suggested_title,
               g.avg_similarity, g.thread_count, g.is_cross_cutting, g.status,
               g.created_at, g.updated_at, g.exported_at,
               g.linear_issue_id, g.linear_issue_url, g.linear_issue_identifier,
               g.linear_project_ids, g.affects_features
      ORDER BY g.thread_count DESC, g.avg_similarity DESC
    `;

    const result = await query(queryText, params);

    return result.rows.map((row: any) => ({
      id: row.id,
      channel_id: row.channel_id,
      github_issue_number: row.github_issue_number,
      suggested_title: row.suggested_title,
      avg_similarity: row.avg_similarity,
      thread_count: row.thread_count,
      is_cross_cutting: row.is_cross_cutting,
      status: row.status,
      created_at: row.created_at?.toISOString() || new Date().toISOString(),
      updated_at: row.updated_at?.toISOString() || new Date().toISOString(),
      exported_at: row.exported_at?.toISOString(),
      linear_issue_id: row.linear_issue_id,
      linear_issue_url: row.linear_issue_url,
      linear_issue_identifier: row.linear_issue_identifier,
      linear_project_ids: row.linear_project_ids,
      affects_features: row.affects_features ? JSON.parse(row.affects_features) : [],
      threads: row.threads || [],
    }));
  }

  async getGroup(groupId: string): Promise<Group | null> {
    const result = await query(
      `SELECT 
        g.id, g.channel_id, g.github_issue_number, g.suggested_title,
        g.avg_similarity, g.thread_count, g.is_cross_cutting, g.status,
        g.created_at, g.updated_at, g.exported_at,
        g.linear_issue_id, g.linear_issue_url, g.linear_issue_identifier,
        g.linear_project_ids, g.affects_features,
        COALESCE(
          json_agg(
            json_build_object(
              'thread_id', gt.thread_id,
              'thread_name', ct.thread_name,
              'similarity_score', gt.similarity_score,
              'url', ct.first_message_url,
              'author', ct.first_message_author,
              'timestamp', ct.first_message_timestamp
            ) ORDER BY gt.similarity_score DESC
          ) FILTER (WHERE gt.thread_id IS NOT NULL),
          '[]'::json
        ) as threads
      FROM groups g
      LEFT JOIN group_threads gt ON g.id = gt.group_id
      LEFT JOIN classified_threads ct ON gt.thread_id = ct.thread_id
      WHERE g.id = $1
      GROUP BY g.id, g.channel_id, g.github_issue_number, g.suggested_title,
               g.avg_similarity, g.thread_count, g.is_cross_cutting, g.status,
               g.created_at, g.updated_at, g.exported_at,
               g.linear_issue_id, g.linear_issue_url, g.linear_issue_identifier,
               g.linear_project_ids, g.affects_features`,
      [groupId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      channel_id: row.channel_id,
      github_issue_number: row.github_issue_number,
      suggested_title: row.suggested_title,
      avg_similarity: row.avg_similarity,
      thread_count: row.thread_count,
      is_cross_cutting: row.is_cross_cutting,
      status: row.status,
      created_at: row.created_at?.toISOString() || new Date().toISOString(),
      updated_at: row.updated_at?.toISOString() || new Date().toISOString(),
      exported_at: row.exported_at?.toISOString(),
      linear_issue_id: row.linear_issue_id,
      linear_issue_url: row.linear_issue_url,
      linear_issue_identifier: row.linear_issue_identifier,
      linear_project_ids: row.linear_project_ids,
      affects_features: row.affects_features ? JSON.parse(row.affects_features) : [],
      threads: row.threads || [],
    };
  }

  async markGroupAsExported(groupId: string, linearIssueId: string, linearIssueUrl: string, projectIds?: string[]): Promise<void> {
    await query(
      `UPDATE groups 
       SET status = 'exported',
           exported_at = NOW(),
           linear_issue_id = $2,
           linear_issue_url = $3,
           linear_project_ids = $4,
           updated_at = NOW()
       WHERE id = $1`,
      [groupId, linearIssueId, linearIssueUrl, projectIds || null]
    );
  }

  async saveUngroupedThread(thread: UngroupedThread): Promise<void> {
    await this.saveUngroupedThreads([thread]);
  }

  async saveUngroupedThreads(threads: UngroupedThread[]): Promise<void> {
    if (threads.length === 0) return;

    await transaction(async (client) => {
      for (const thread of threads) {
        // Ensure thread exists in classified_threads
        await client.query(
          `INSERT INTO classified_threads (thread_id, channel_id, thread_name, status)
           VALUES ($1, $2, $3, 'completed')
           ON CONFLICT (thread_id) DO NOTHING`,
          [thread.thread_id, thread.channel_id, thread.thread_name || null]
        );

        // Upsert ungrouped thread
        await client.query(
          `INSERT INTO ungrouped_threads (
            thread_id, channel_id, reason,
            top_issue_number, top_issue_title, top_issue_similarity,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
          ON CONFLICT (thread_id) DO UPDATE SET
            reason = EXCLUDED.reason,
            top_issue_number = EXCLUDED.top_issue_number,
            top_issue_title = EXCLUDED.top_issue_title,
            top_issue_similarity = EXCLUDED.top_issue_similarity,
            updated_at = NOW()`,
          [
            thread.thread_id,
            thread.channel_id,
            thread.reason,
            thread.top_issue?.number || null,
            thread.top_issue?.title || null,
            thread.top_issue?.similarity_score || null,
          ]
        );
      }
    });
  }

  async getUngroupedThreads(channelId: string): Promise<UngroupedThread[]> {
    const result = await query(
      `SELECT 
        ut.thread_id, ut.channel_id, ut.reason,
        ut.top_issue_number, ut.top_issue_title, ut.top_issue_similarity,
        ct.thread_name, ct.first_message_url as url,
        ct.first_message_author as author, ct.first_message_timestamp as timestamp
      FROM ungrouped_threads ut
      JOIN classified_threads ct ON ut.thread_id = ct.thread_id
      WHERE ut.channel_id = $1
      ORDER BY ut.updated_at DESC`,
      [channelId]
    );

    return result.rows.map((row: any) => ({
      thread_id: row.thread_id,
      channel_id: row.channel_id,
      thread_name: row.thread_name,
      url: row.url,
      author: row.author,
      timestamp: row.timestamp?.toISOString(),
      reason: row.reason,
      top_issue: row.top_issue_number ? {
        number: row.top_issue_number,
        title: row.top_issue_title,
        similarity_score: row.top_issue_similarity,
      } : undefined,
    }));
  }

  async getStats(channelId: string): Promise<StorageStats> {
    const threadsResult = await query(
      `SELECT COUNT(*) as count FROM classified_threads WHERE channel_id = $1`,
      [channelId]
    );
    const totalThreads = parseInt(threadsResult.rows[0].count);

    const groupsResult = await query(
      `SELECT 
        COUNT(*) as total,
        SUM(thread_count) as grouped_threads,
        COUNT(*) FILTER (WHERE thread_count > 1) as multi_thread,
        COUNT(*) FILTER (WHERE thread_count = 1) as single_thread
      FROM groups WHERE channel_id = $1`,
      [channelId]
    );
    const groupedThreads = parseInt(groupsResult.rows[0].grouped_threads || "0");
    const multiThreadGroups = parseInt(groupsResult.rows[0].multi_thread || "0");
    const singleThreadGroups = parseInt(groupsResult.rows[0].single_thread || "0");

    const ungroupedResult = await query(
      `SELECT COUNT(*) as count FROM ungrouped_threads WHERE channel_id = $1`,
      [channelId]
    );
    const ungroupedThreads = parseInt(ungroupedResult.rows[0].count);

    const issuesResult = await query(
      `SELECT COUNT(DISTINCT issue_number) as count 
       FROM thread_issue_matches tim
       JOIN classified_threads ct ON tim.thread_id = ct.thread_id
       WHERE ct.channel_id = $1`,
      [channelId]
    );
    const uniqueIssues = parseInt(issuesResult.rows[0].count || "0");

    return {
      totalThreads,
      groupedThreads,
      ungroupedThreads,
      uniqueIssues,
      multiThreadGroups,
      singleThreadGroups,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async saveDocumentation(doc: DocumentationContent): Promise<void> {
    await this.saveDocumentationMultiple([doc]);
  }

  async saveDocumentationMultiple(docs: DocumentationContent[]): Promise<void> {
    if (docs.length === 0) return;

    await transaction(async (client) => {
      for (const doc of docs) {
        await client.query(
          `INSERT INTO documentation_cache (url, title, content, sections, fetched_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (url) DO UPDATE SET
             title = EXCLUDED.title,
             content = EXCLUDED.content,
             sections = EXCLUDED.sections,
             fetched_at = EXCLUDED.fetched_at,
             updated_at = NOW()`,
          [
            doc.url,
            doc.title || null,
            doc.content,
            doc.sections ? JSON.stringify(doc.sections) : null,
            doc.fetched_at ? new Date(doc.fetched_at) : new Date(),
          ]
        );
      }
    });
  }

  async getDocumentation(url: string): Promise<DocumentationContent | null> {
    const result = await query(
      `SELECT url, title, content, sections, fetched_at
       FROM documentation_cache
       WHERE url = $1`,
      [url]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      url: row.url,
      title: row.title || undefined,
      content: row.content,
      sections: row.sections ? JSON.parse(row.sections) : undefined,
      fetched_at: row.fetched_at?.toISOString() || new Date().toISOString(),
    };
  }

  async getDocumentationMultiple(urls: string[]): Promise<DocumentationContent[]> {
    if (urls.length === 0) return [];

    const result = await query(
      `SELECT url, title, content, sections, fetched_at
       FROM documentation_cache
       WHERE url = ANY($1)`,
      [urls]
    );

    return result.rows.map((row: any) => ({
      url: row.url,
      title: row.title || undefined,
      content: row.content,
      sections: row.sections ? JSON.parse(row.sections) : undefined,
      fetched_at: row.fetched_at?.toISOString() || new Date().toISOString(),
    }));
  }

  async getAllCachedDocumentation(): Promise<DocumentationContent[]> {
    const result = await query(
      `SELECT url, title, content, sections, fetched_at
       FROM documentation_cache
       ORDER BY fetched_at DESC`
    );

    return result.rows.map((row: any) => ({
      url: row.url,
      title: row.title || undefined,
      content: row.content,
      sections: row.sections ? JSON.parse(row.sections) : undefined,
      fetched_at: row.fetched_at?.toISOString() || new Date().toISOString(),
    }));
  }

  async clearDocumentationCache(): Promise<void> {
    await query("DELETE FROM documentation_cache");
  }

  async saveFeatures(urls: string[], features: any[], docCount: number): Promise<void> {
    // Sort URLs for consistent comparison
    const sortedUrls = [...urls].map(u => u.toLowerCase().trim()).sort();
    
    await transaction(async (client) => {
      // Insert each feature as a separate row (normalized)
      for (const feature of features) {
        await client.query(
          `INSERT INTO features (id, name, description, category, priority, related_keywords, documentation_section, documentation_urls, extracted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             description = EXCLUDED.description,
             category = EXCLUDED.category,
             priority = EXCLUDED.priority,
             related_keywords = EXCLUDED.related_keywords,
             documentation_section = EXCLUDED.documentation_section,
             documentation_urls = EXCLUDED.documentation_urls,
             extracted_at = EXCLUDED.extracted_at,
             updated_at = NOW()`,
          [
            feature.id,
            feature.name,
            feature.description || null,
            feature.category || null,
            feature.priority || null,
            feature.related_keywords || [],
            feature.documentation_section || null,
            sortedUrls,
          ]
        );
      }
    });
  }

  async getFeatures(urls: string[]): Promise<{ features: any[]; extracted_at: string; documentation_count: number } | null> {
    // Sort URLs for consistent comparison
    const sortedUrls = [...urls].map(u => u.toLowerCase().trim()).sort();
    
    // Query features that match all the provided URLs
    const result = await query(
      `SELECT 
         json_agg(
           json_build_object(
             'id', id,
             'name', name,
             'description', description,
             'category', category,
             'priority', priority,
             'related_keywords', related_keywords,
             'documentation_section', documentation_section
           ) ORDER BY id
         ) as features,
         MAX(extracted_at) as extracted_at,
         COUNT(*) as documentation_count
       FROM features
       WHERE documentation_urls @> $1::text[]`,
      [sortedUrls]
    );

    if (result.rows.length === 0 || !result.rows[0].features || result.rows[0].features.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      features: row.features || [],
      extracted_at: row.extracted_at?.toISOString() || new Date().toISOString(),
      documentation_count: row.documentation_count || 0,
    };
  }

  async clearFeaturesCache(): Promise<void> {
    await query("DELETE FROM features");
  }

  async saveClassificationHistoryEntry(channelId: string, messageId: string, threadId?: string): Promise<void> {
    await query(
      `INSERT INTO classification_history (channel_id, message_id, thread_id, classified_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (channel_id, message_id) DO UPDATE SET
         thread_id = EXCLUDED.thread_id,
         classified_at = NOW()`,
      [channelId, messageId, threadId || null]
    );
  }

  async getClassificationHistory(channelId: string): Promise<Array<{ message_id: string; thread_id?: string; classified_at: string }>> {
    const result = await query(
      `SELECT message_id, thread_id, classified_at
       FROM classification_history
       WHERE channel_id = $1
       ORDER BY classified_at DESC`,
      [channelId]
    );

    return result.rows.map(row => ({
      message_id: row.message_id,
      thread_id: row.thread_id || undefined,
      classified_at: row.classified_at?.toISOString() || new Date().toISOString(),
    }));
  }
}

