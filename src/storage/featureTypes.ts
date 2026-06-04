/**
 * Feature + documentation shapes referenced by the storage layer.
 *
 * These types originally lived in `export/` (the PM-export pipeline that moved
 * to the unMute project). The storage facade still types a few feature/doc
 * persistence helpers against them, so the definitions live here in a neutral,
 * dependency-free module that both halves can rely on.
 */

export interface ProductFeature {
  id: string;
  name: string;
  description: string;
  category?: string;
  documentation_section?: string;
  related_keywords: string[];
  priority?: "urgent" | "high" | "medium" | "low";
}

export interface DocumentationContent {
  url: string;
  title?: string;
  content: string;
  sections?: Array<{
    title: string;
    content: string;
    url?: string;
  }>;
  fetched_at: string;
}
