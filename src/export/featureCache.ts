/**
 * Feature cache - stores extracted features to avoid re-extraction
 * Features are cached based on documentation URLs
 * Uses storage backend (JSON or database) automatically
 */

import { getStorage } from "../storage/factory.js";
import { fetchMultipleDocumentation } from "./documentationFetcher.js";
import { extractFeaturesFromDocumentation } from "./featureExtractor.js";
import type { ProductFeature } from "./types.js";
import { log } from "../mcp/logger.js";

/**
 * Clear features cache
 */
export async function clearFeaturesCache(): Promise<void> {
  const storage = getStorage();
  await storage.clearFeaturesCache();
}

/**
 * Get features from cache or extract from documentation
 * This is the main function to use - it handles caching automatically
 */
export async function getFeaturesFromCacheOrExtract(
  urls: string[],
  options?: {
    force_refresh?: boolean;
    use_doc_cache?: boolean;
  }
): Promise<ProductFeature[]> {
  const { force_refresh = false, use_doc_cache = true } = options || {};
  const storage = getStorage();
  
  // Check cache first (unless force refresh)
  if (!force_refresh) {
    const cached = await storage.getFeatures(urls);
    if (cached && cached.features && cached.features.length > 0) {
      log(`Using cached features (${cached.features.length} features from ${urls.length} URL(s), extracted at ${cached.extracted_at})`);
      return cached.features as ProductFeature[];
    }
  }
  
  // Cache miss or force refresh - fetch and extract
  log(`Extracting features from documentation (${urls.length} URL(s))...`);
  const docs = await fetchMultipleDocumentation(urls, true, use_doc_cache);
  
  if (docs.length === 0) {
    throw new Error("No documentation was successfully fetched");
  }
  
  const features = await extractFeaturesFromDocumentation(docs);
  
  // Save to cache (uses storage backend - JSON or database)
  await storage.saveFeatures(urls, features, docs.length);
  log(`Extracted and cached ${features.length} features from ${docs.length} documentation pages`);
  
  return features;
}

/**
 * Get cached features info (metadata only)
 * Requires URLs to check - uses config URLs if not provided
 */
export async function getCachedFeaturesInfo(urls?: string[]): Promise<{
  urls: string[];
  feature_count: number;
  extracted_at: string;
  documentation_count: number;
} | null> {
  const storage = getStorage();
  
  // If no URLs provided, try to get from config
  if (!urls || urls.length === 0) {
    const { getConfig } = await import("../config/index.js");
    const config = getConfig();
    urls = config.pmIntegration?.documentation_urls || [];
  }
  
  if (!urls || urls.length === 0) {
    return null;
  }
  
  // Try to get cached features
  const cached = await storage.getFeatures(urls);
  if (cached) {
    return {
      urls,
      feature_count: cached.features.length,
      extracted_at: cached.extracted_at,
      documentation_count: cached.documentation_count,
    };
  }
  
  return null;
}

