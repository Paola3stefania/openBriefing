/**
 * Embedding storage operations for documentation, sections, and features
 */

import { query, transaction } from "./client.js";
import { createHash } from "crypto";
import type { DocumentationContent } from "../../export/documentationFetcher.js";
import type { ProductFeature } from "../../export/types.js";
import { createEmbedding } from "../../core/classify/semantic.js";
import { getConfig } from "../../config/index.js";

export type Embedding = number[];

/**
 * Get the embedding model from config
 */
function getEmbeddingModel(): string {
  const config = getConfig();
  return config.classification.embeddingModel;
}

/**
 * Create hash of content for change detection
 */
function hashContent(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

/**
 * Save documentation section embedding
 */
export async function saveDocumentationSectionEmbedding(
  sectionId: number,
  documentationUrl: string,
  embedding: Embedding,
  contentHash: string
): Promise<void> {
  const model = getEmbeddingModel();
  await query(
    `INSERT INTO documentation_section_embeddings (section_id, documentation_url, embedding, content_hash, model)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (section_id) DO UPDATE SET
       embedding = EXCLUDED.embedding,
       content_hash = EXCLUDED.content_hash,
       model = EXCLUDED.model,
       documentation_url = EXCLUDED.documentation_url,
       updated_at = NOW()`,
    [sectionId, documentationUrl, JSON.stringify(embedding), contentHash, model]
  );
}

/**
 * Get documentation section embedding
 */
export async function getDocumentationSectionEmbedding(sectionId: number): Promise<Embedding | null> {
  const model = getEmbeddingModel();
  const result = await query(
    `SELECT embedding FROM documentation_section_embeddings
     WHERE section_id = $1 AND model = $2`,
    [sectionId, model]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].embedding as Embedding;
}

/**
 * Save full documentation embedding
 */
export async function saveDocumentationEmbedding(
  url: string,
  embedding: Embedding,
  contentHash: string
): Promise<void> {
  const model = getEmbeddingModel();
  await query(
    `INSERT INTO documentation_embeddings (documentation_url, embedding, content_hash, model)
     VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (documentation_url) DO UPDATE SET
       embedding = EXCLUDED.embedding,
       content_hash = EXCLUDED.content_hash,
       model = EXCLUDED.model,
       updated_at = NOW()`,
    [url, JSON.stringify(embedding), contentHash, model]
  );
}

/**
 * Get documentation embedding
 */
export async function getDocumentationEmbedding(url: string): Promise<Embedding | null> {
  const model = getEmbeddingModel();
  const result = await query(
    `SELECT embedding FROM documentation_embeddings
     WHERE documentation_url = $1 AND model = $2`,
    [url, model]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].embedding as Embedding;
}

/**
 * Save feature embedding
 */
export async function saveFeatureEmbedding(
  featureId: string,
  embedding: Embedding,
  contentHash: string
): Promise<void> {
  const model = getEmbeddingModel();
  await query(
    `INSERT INTO feature_embeddings (feature_id, embedding, content_hash, model)
     VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (feature_id) DO UPDATE SET
       embedding = EXCLUDED.embedding,
       content_hash = EXCLUDED.content_hash,
       model = EXCLUDED.model,
       updated_at = NOW()`,
    [featureId, JSON.stringify(embedding), contentHash, model]
  );
}

/**
 * Get feature embedding
 */
export async function getFeatureEmbedding(featureId: string): Promise<Embedding | null> {
  const model = getEmbeddingModel();
  const result = await query(
    `SELECT embedding FROM feature_embeddings
     WHERE feature_id = $1 AND model = $2`,
    [featureId, model]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].embedding as Embedding;
}

/**
 * Compute and save embeddings for all documentation sections
 */
export async function computeAndSaveDocumentationSectionEmbeddings(
  apiKey: string,
  onProgress?: (processed: number, total: number) => void
): Promise<void> {
  // Get all sections that need embeddings
  const sectionsResult = await query(
    `SELECT id, documentation_url, title, content
     FROM documentation_sections
     ORDER BY id`
  );

  const allSections = sectionsResult.rows;
  const model = getEmbeddingModel();

  // Check which sections already have embeddings
  const existingEmbeddings = await query(
    `SELECT section_id, content_hash
     FROM documentation_section_embeddings
     WHERE model = $1`,
    [model]
  );

  const existingHashes = new Map<number, string>();
  for (const row of existingEmbeddings.rows) {
    existingHashes.set(row.section_id, row.content_hash);
  }

  // Compute content hashes and find sections that need embeddings
  const sectionsToEmbed: Array<{ id: number; url: string; title: string; content: string }> = [];
  for (const section of allSections) {
    const contentText = `${section.title}\n\n${section.content}`;
    const currentHash = hashContent(contentText);
    const existingHash = existingHashes.get(section.id);

    if (!existingHash || existingHash !== currentHash) {
      sectionsToEmbed.push({
        id: section.id,
        url: section.documentation_url,
        title: section.title,
        content: section.content,
      });
    }
  }

  console.error(`[Embeddings] Found ${allSections.length} sections, ${sectionsToEmbed.length} need embeddings`);

  // Process in batches
  const batchSize = 10;
  let processed = 0;

  for (let i = 0; i < sectionsToEmbed.length; i += batchSize) {
    const batch = sectionsToEmbed.slice(i, i + batchSize);

    for (const section of batch) {
      try {
        const contentText = `${section.title}\n\n${section.content}`;
        const embedding = await createEmbedding(contentText, apiKey);
        const contentHash = hashContent(contentText);

        await saveDocumentationSectionEmbedding(section.id, section.url, embedding, contentHash);
        processed++;

        if (onProgress) {
          onProgress(processed, sectionsToEmbed.length);
        }

        // Small delay to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`[Embeddings] Failed to embed section ${section.id}:`, error);
      }
    }

    // Delay between batches
    if (i + batchSize < sectionsToEmbed.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.error(`[Embeddings] Completed section embeddings: ${processed}/${sectionsToEmbed.length}`);
}

/**
 * Compute and save embeddings for all documentation pages
 */
export async function computeAndSaveDocumentationEmbeddings(
  apiKey: string,
  onProgress?: (processed: number, total: number) => void
): Promise<void> {
  // Get all documentation that needs embeddings
  const docsResult = await query(
    `SELECT url, title, content
     FROM documentation_cache
     ORDER BY url`
  );

  const allDocs = docsResult.rows;
  const model = getEmbeddingModel();

  // Check which docs already have embeddings
  const existingEmbeddings = await query(
    `SELECT documentation_url, content_hash
     FROM documentation_embeddings
     WHERE model = $1`,
    [model]
  );

  const existingHashes = new Map<string, string>();
  for (const row of existingEmbeddings.rows) {
    existingHashes.set(row.documentation_url, row.content_hash);
  }

  // Compute content hashes and find docs that need embeddings
  const docsToEmbed: Array<{ url: string; title: string; content: string }> = [];
  for (const doc of allDocs) {
    const contentText = doc.title ? `${doc.title}\n\n${doc.content}` : doc.content;
    const currentHash = hashContent(contentText);
    const existingHash = existingHashes.get(doc.url);

    if (!existingHash || existingHash !== currentHash) {
      docsToEmbed.push({
        url: doc.url,
        title: doc.title || "",
        content: doc.content,
      });
    }
  }

  console.error(`[Embeddings] Found ${allDocs.length} docs, ${docsToEmbed.length} need embeddings`);

  // Process in batches
  const batchSize = 10;
  let processed = 0;

  for (let i = 0; i < docsToEmbed.length; i += batchSize) {
    const batch = docsToEmbed.slice(i, i + batchSize);

    for (const doc of batch) {
      try {
        const contentText = doc.title ? `${doc.title}\n\n${doc.content}` : doc.content;
        const embedding = await createEmbedding(contentText, apiKey);
        const contentHash = hashContent(contentText);

        await saveDocumentationEmbedding(doc.url, embedding, contentHash);
        processed++;

        if (onProgress) {
          onProgress(processed, docsToEmbed.length);
        }

        // Small delay to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`[Embeddings] Failed to embed doc ${doc.url}:`, error);
      }
    }

    // Delay between batches
    if (i + batchSize < docsToEmbed.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.error(`[Embeddings] Completed doc embeddings: ${processed}/${docsToEmbed.length}`);
}

/**
 * Compute and save embeddings for all features
 */
export async function computeAndSaveFeatureEmbeddings(
  apiKey: string,
  onProgress?: (processed: number, total: number) => void
): Promise<void> {
  // Get all features that need embeddings
  const featuresResult = await query(
    `SELECT id, name, description, related_keywords
     FROM features
     ORDER BY id`
  );

  const allFeatures = featuresResult.rows;
  const model = getEmbeddingModel();

  // Check which features already have embeddings
  const existingEmbeddings = await query(
    `SELECT feature_id, content_hash
     FROM feature_embeddings
     WHERE model = $1`,
    [model]
  );

  const existingHashes = new Map<string, string>();
  for (const row of existingEmbeddings.rows) {
    existingHashes.set(row.feature_id, row.content_hash);
  }

  // Compute content hashes and find features that need embeddings
  const featuresToEmbed: Array<{ id: string; name: string; description: string; keywords: string[] }> = [];
  for (const feature of allFeatures) {
    const keywords = Array.isArray(feature.related_keywords) ? feature.related_keywords : [];
    const contentText = `${feature.name}${feature.description ? `: ${feature.description}` : ""}${keywords.length > 0 ? ` Keywords: ${keywords.join(", ")}` : ""}`;
    const currentHash = hashContent(contentText);
    const existingHash = existingHashes.get(feature.id);

    if (!existingHash || existingHash !== currentHash) {
      featuresToEmbed.push({
        id: feature.id,
        name: feature.name,
        description: feature.description || "",
        keywords: keywords,
      });
    }
  }

  console.error(`[Embeddings] Found ${allFeatures.length} features, ${featuresToEmbed.length} need embeddings`);

  // Process in batches
  const batchSize = 10;
  let processed = 0;

  for (let i = 0; i < featuresToEmbed.length; i += batchSize) {
    const batch = featuresToEmbed.slice(i, i + batchSize);

    for (const feature of batch) {
      try {
        const keywords = feature.keywords.length > 0 ? ` Keywords: ${feature.keywords.join(", ")}` : "";
        const contentText = `${feature.name}${feature.description ? `: ${feature.description}` : ""}${keywords}`;
        const embedding = await createEmbedding(contentText, apiKey);
        const contentHash = hashContent(contentText);

        await saveFeatureEmbedding(feature.id, embedding, contentHash);
        processed++;

        if (onProgress) {
          onProgress(processed, featuresToEmbed.length);
        }

        // Small delay to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`[Embeddings] Failed to embed feature ${feature.id}:`, error);
      }
    }

    // Delay between batches
    if (i + batchSize < featuresToEmbed.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.error(`[Embeddings] Completed feature embeddings: ${processed}/${featuresToEmbed.length}`);
}

/**
 * Compute embeddings for all documentation, sections, and features
 */
export async function computeAllEmbeddings(
  apiKey: string,
  options?: {
    skipDocs?: boolean;
    skipSections?: boolean;
    skipFeatures?: boolean;
  }
): Promise<void> {
  console.error("[Embeddings] Starting batch embedding computation...");

  if (!options?.skipDocs) {
    await computeAndSaveDocumentationEmbeddings(apiKey);
  }

  if (!options?.skipSections) {
    await computeAndSaveDocumentationSectionEmbeddings(apiKey);
  }

  if (!options?.skipFeatures) {
    await computeAndSaveFeatureEmbeddings(apiKey);
  }

  console.error("[Embeddings] Completed all embedding computations");
}

