/**
 * Storage interface - allows switching between JSON and PostgreSQL
 */

import type { ClassifiedThread, Group, UngroupedThread, StorageStats } from "./types.js";
import type { DocumentationContent } from "../export/documentationFetcher.js";

export interface IStorage {
  // Channel operations
  upsertChannel(channelId: string, channelName?: string, guildId?: string): Promise<void>;
  
  // Classification operations
  saveClassifiedThread(thread: ClassifiedThread): Promise<void>;
  saveClassifiedThreads(threads: ClassifiedThread[]): Promise<void>;
  getClassifiedThreads(channelId: string): Promise<ClassifiedThread[]>;
  getClassifiedThread(threadId: string): Promise<ClassifiedThread | null>;
  
  // Group operations
  saveGroup(group: Group): Promise<void>;
  saveGroups(groups: Group[]): Promise<void>;
  getGroups(channelId: string, options?: { status?: "pending" | "exported" }): Promise<Group[]>;
  getGroup(groupId: string): Promise<Group | null>;
  markGroupAsExported(groupId: string, linearIssueId: string, linearIssueUrl: string, projectIds?: string[]): Promise<void>;
  
  // Ungrouped threads
  saveUngroupedThread(thread: UngroupedThread): Promise<void>;
  saveUngroupedThreads(threads: UngroupedThread[]): Promise<void>;
  getUngroupedThreads(channelId: string): Promise<UngroupedThread[]>;
  
  // Documentation cache operations
  saveDocumentation(doc: DocumentationContent): Promise<void>;
  saveDocumentationMultiple(docs: DocumentationContent[]): Promise<void>;
  getDocumentation(url: string): Promise<DocumentationContent | null>;
  getDocumentationMultiple(urls: string[]): Promise<DocumentationContent[]>;
  getAllCachedDocumentation(): Promise<DocumentationContent[]>;
  clearDocumentationCache(): Promise<void>;
  
  // Feature cache operations
  saveFeatures(urls: string[], features: any[], docCount: number): Promise<void>;
  getFeatures(urls: string[]): Promise<{ features: any[]; extracted_at: string; documentation_count: number } | null>;
  clearFeaturesCache(): Promise<void>;
  
  // Stats
  getStats(channelId: string): Promise<StorageStats>;
  
  // Health check
  isAvailable(): Promise<boolean>;
}

