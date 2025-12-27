/**
 * Shared embedding cache for semantic operations
 * Used by both classification and grouping
 * Persists embeddings to database (if available) or disk to avoid redundant API calls
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { getConfig } from "../../config/index.js";
import { query, checkConnection } from "../db/client.js";

// Embedding vector type (OpenAI returns 1536-dimensional vectors)
export type Embedding = number[];

// Cache entry with content hash for invalidation
interface EmbeddingEntry {
  embedding: Embedding;
  contentHash: string;
  createdAt: string;
}

// Persistent cache structure
interface EmbeddingCacheFile {
  version: number;
  model: string;
  entries: Record<string, EmbeddingEntry>;
}

const CACHE_VERSION = 1;

/**
 * Get the embedding model from config
 */
function getEmbeddingModel(): string {
  const config = getConfig();
  return config.classification.embeddingModel;
}

// In-memory cache for fast access during runtime
const memoryCache: Map<string, Embedding> = new Map();

// Cache whether database is available (lazy initialization)
let dbAvailable: boolean | null = null;

/**
 * Check if database is available for storing embeddings
 */
async function isDatabaseAvailable(): Promise<boolean> {
  if (dbAvailable !== null) {
    return dbAvailable;
  }
  
  try {
    dbAvailable = await checkConnection();
    return dbAvailable;
  } catch {
    dbAvailable = false;
    return false;
  }
}

/**
 * Get the path to an embeddings cache file
 */
function getCachePath(cacheType: "issues" | "discord"): string {
  const config = getConfig();
  const cacheDir = join(process.cwd(), config.paths.cacheDir);
  
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  
  const fileName = cacheType === "issues" 
    ? "issue-embeddings-cache.json"
    : "discord-embeddings-cache.json";
    
  return join(cacheDir, fileName);
}

/**
 * Create a hash of content for change detection
 */
export function hashContent(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

/**
 * Load persistent cache from disk
 */
function loadCache(cacheType: "issues" | "discord"): EmbeddingCacheFile {
  const cachePath = getCachePath(cacheType);
  const currentModel = getEmbeddingModel();
  
  if (!existsSync(cachePath)) {
    return { version: CACHE_VERSION, model: currentModel, entries: {} };
  }
  
  try {
    const data = readFileSync(cachePath, "utf-8");
    const cache = JSON.parse(data) as EmbeddingCacheFile;
    
    // Check version and model compatibility
    if (cache.version !== CACHE_VERSION || cache.model !== currentModel) {
      console.error(`[EmbeddingCache] Version/model mismatch for ${cacheType} (cached: ${cache.model}, current: ${currentModel}), starting fresh`);
      return { version: CACHE_VERSION, model: currentModel, entries: {} };
    }
    
    return cache;
  } catch (error) {
    console.error(`[EmbeddingCache] Failed to load ${cacheType} cache, starting fresh`);
    return { version: CACHE_VERSION, model: currentModel, entries: {} };
  }
}

/**
 * Save cache to disk
 */
function saveCache(cacheType: "issues" | "discord", cache: EmbeddingCacheFile): void {
  const cachePath = getCachePath(cacheType);
  
  try {
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  } catch (error) {
    console.error(`[EmbeddingCache] Failed to save ${cacheType} cache:`, error);
  }
}

/**
 * Get cached embedding for an item
 * Returns undefined if not cached or content changed
 */
export async function getCachedEmbedding(
  cacheType: "issues" | "discord",
  id: string,
  contentHash: string
): Promise<Embedding | undefined> {
  // Check memory cache first
  const memKey = `${cacheType}:${id}`;
  if (memoryCache.has(memKey)) {
    return memoryCache.get(memKey);
  }
  
  // For issue embeddings, try database first if available
  if (cacheType === "issues" && await isDatabaseAvailable()) {
    try {
      const issueNumber = parseInt(id, 10);
      if (!isNaN(issueNumber)) {
        const currentModel = getEmbeddingModel();
        const result = await query<{
          embedding: number[];
          content_hash: string;
          model: string;
        }>(
          `SELECT embedding, content_hash, model 
           FROM issue_embeddings 
           WHERE issue_number = $1 AND model = $2`,
          [issueNumber, currentModel]
        );
        
        if (result.rows.length > 0) {
          const row = result.rows[0];
          if (row.content_hash === contentHash) {
            // Content matches, use cached embedding
            memoryCache.set(memKey, row.embedding);
            return row.embedding;
          }
          // Content hash mismatch means issue changed, return undefined to re-embed
          return undefined;
        }
      }
    } catch (error) {
      // Database error, fall back to JSON cache
      console.error(`[EmbeddingCache] Database error, falling back to JSON:`, error);
    }
  }
  
  // Fall back to disk cache (or for discord embeddings)
  const cache = loadCache(cacheType);
  const entry = cache.entries[id];
  
  if (entry && entry.contentHash === contentHash) {
    // Load into memory cache for faster subsequent access
    memoryCache.set(memKey, entry.embedding);
    return entry.embedding;
  }
  
  return undefined;
}

/**
 * Save embedding to cache
 */
export async function setCachedEmbedding(
  cacheType: "issues" | "discord",
  id: string,
  contentHash: string,
  embedding: Embedding
): Promise<void> {
  // Save to memory cache
  const memKey = `${cacheType}:${id}`;
  memoryCache.set(memKey, embedding);
  
  // For issue embeddings, save to database first if available
  if (cacheType === "issues" && await isDatabaseAvailable()) {
    try {
      const issueNumber = parseInt(id, 10);
      if (!isNaN(issueNumber)) {
        const currentModel = getEmbeddingModel();
        await query(
          `INSERT INTO issue_embeddings (issue_number, embedding, content_hash, model, updated_at)
           VALUES ($1, $2::jsonb, $3, $4, NOW())
           ON CONFLICT (issue_number) 
           DO UPDATE SET 
             embedding = $2::jsonb,
             content_hash = $3,
             model = $4,
             updated_at = NOW()`,
          [issueNumber, JSON.stringify(embedding) as any, contentHash, currentModel]
        );
        return; // Successfully saved to database, skip JSON cache
      }
    } catch (error) {
      // Database error, fall back to JSON cache
      console.error(`[EmbeddingCache] Database save error, falling back to JSON:`, error);
    }
  }
  
  // Fall back to disk cache (or for discord embeddings)
  const cache = loadCache(cacheType);
  cache.entries[id] = {
    embedding,
    contentHash,
    createdAt: new Date().toISOString(),
  };
  saveCache(cacheType, cache);
}

/**
 * Batch save embeddings (more efficient for multiple items)
 */
export async function batchSetCachedEmbeddings(
  cacheType: "issues" | "discord",
  items: Array<{ id: string; contentHash: string; embedding: Embedding }>
): Promise<void> {
  // For issue embeddings, save to database first if available
  if (cacheType === "issues" && await isDatabaseAvailable()) {
    try {
      const currentModel = getEmbeddingModel();
      // Use a transaction for batch insert
      const values: Array<[number, string, string]> = [];
      for (const item of items) {
        const issueNumber = parseInt(item.id, 10);
        if (!isNaN(issueNumber)) {
          values.push([issueNumber, JSON.stringify(item.embedding), item.contentHash]);
          // Save to memory cache
          const memKey = `${cacheType}:${item.id}`;
          memoryCache.set(memKey, item.embedding);
        }
      }
      
      if (values.length > 0) {
        // Batch insert using individual INSERT statements
        // We do them in a loop - could be optimized with a transaction wrapper, but this is simpler
        for (const [issueNumber, embeddingJson, contentHash] of values) {
          await query(
            `INSERT INTO issue_embeddings (issue_number, embedding, content_hash, model, updated_at)
             VALUES ($1, $2::jsonb, $3, $4, NOW())
             ON CONFLICT (issue_number)
             DO UPDATE SET
               embedding = EXCLUDED.embedding,
               content_hash = EXCLUDED.content_hash,
               model = EXCLUDED.model,
               updated_at = EXCLUDED.updated_at`,
            [issueNumber, embeddingJson as any, contentHash, currentModel]
          );
        }
        return; // Successfully saved to database, skip JSON cache
      }
    } catch (error) {
      // Database error, fall back to JSON cache
      console.error(`[EmbeddingCache] Database batch save error, falling back to JSON:`, error);
    }
  }
  
  // Fall back to disk cache (or for discord embeddings)
  const cache = loadCache(cacheType);
  
  for (const item of items) {
    // Save to memory cache
    const memKey = `${cacheType}:${item.id}`;
    memoryCache.set(memKey, item.embedding);
    
    // Add to disk cache
    cache.entries[item.id] = {
      embedding: item.embedding,
      contentHash: item.contentHash,
      createdAt: new Date().toISOString(),
    };
  }
  
  saveCache(cacheType, cache);
}

/**
 * Get all cached embeddings for a cache type
 * Useful for grouping operations
 */
export async function getAllCachedEmbeddings(
  cacheType: "issues" | "discord"
): Promise<Map<string, Embedding>> {
  // For issue embeddings, load from database first if available
  if (cacheType === "issues" && await isDatabaseAvailable()) {
    try {
      const currentModel = getEmbeddingModel();
      const result = await query<{
        issue_number: number;
        embedding: number[];
      }>(
        `SELECT issue_number, embedding 
         FROM issue_embeddings 
         WHERE model = $1`,
        [currentModel]
      );
      
      const embeddingsMap = new Map<string, Embedding>();
      for (const row of result.rows) {
        const id = row.issue_number.toString();
        embeddingsMap.set(id, row.embedding);
        // Also populate memory cache
        const memKey = `${cacheType}:${id}`;
        memoryCache.set(memKey, row.embedding);
      }
      
      return embeddingsMap;
    } catch (error) {
      // Database error, fall back to JSON cache
      console.error(`[EmbeddingCache] Database load error, falling back to JSON:`, error);
    }
  }
  
  // Fall back to disk cache (or for discord embeddings)
  const cache = loadCache(cacheType);
  const result = new Map<string, Embedding>();
  
  for (const [id, entry] of Object.entries(cache.entries)) {
    result.set(id, entry.embedding);
    // Also populate memory cache
    const memKey = `${cacheType}:${id}`;
    memoryCache.set(memKey, entry.embedding);
  }
  
  return result;
}

/**
 * Get cache statistics
 */
export function getCacheStats(cacheType: "issues" | "discord"): {
  count: number;
  cacheFile: string;
} {
  const cache = loadCache(cacheType);
  return {
    count: Object.keys(cache.entries).length,
    cacheFile: getCachePath(cacheType),
  };
}

/**
 * Clear cache (useful for testing or reset)
 */
export async function clearCache(cacheType: "issues" | "discord"): Promise<void> {
  // For issue embeddings, clear from database if available
  if (cacheType === "issues" && await isDatabaseAvailable()) {
    try {
      const currentModel = getEmbeddingModel();
      await query(
        `DELETE FROM issue_embeddings WHERE model = $1`,
        [currentModel]
      );
    } catch (error) {
      console.error(`[EmbeddingCache] Database clear error:`, error);
    }
  }
  
  // Also clear JSON cache
  const cache: EmbeddingCacheFile = {
    version: CACHE_VERSION,
    model: getEmbeddingModel(),
    entries: {},
  };
  saveCache(cacheType, cache);
  
  // Clear memory cache for this type
  for (const key of memoryCache.keys()) {
    if (key.startsWith(`${cacheType}:`)) {
      memoryCache.delete(key);
    }
  }
}

