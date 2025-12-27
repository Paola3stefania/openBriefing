/**
 * Documentation fetcher
 * Fetches and parses documentation from URLs or local file paths
 * Supports caching via storage backend (database or JSON)
 */

import { log, logError } from "../mcp/logger.js";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, isAbsolute } from "path";
import { getStorage } from "../storage/factory.js";

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

/**
 * Fetch documentation from a URL or local file path
 * Supports:
 * - HTTP/HTTPS URLs (HTML pages, Markdown files, plain text)
 * - Local file paths (absolute or relative to process.cwd())
 *   - .md, .txt, .html files
 */
export async function fetchDocumentation(urlOrPath: string): Promise<DocumentationContent> {
  try {
    // Log removed to avoid interfering with MCP JSON protocol
    // log(`Fetching documentation from: ${urlOrPath}`);
    
    // Check if it's a URL (starts with http:// or https://)
    const isUrl = urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://");
    
    let content: string;
    let title: string | undefined;
    
    if (isUrl) {
      // Fetch from URL
      const response = await fetch(urlOrPath, {
        headers: {
          "User-Agent": "Discord-MCP-Bot/1.0",
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch documentation: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type") || "";
      content = await response.text();

      // Extract text content from HTML if needed
      if (contentType.includes("text/html")) {
        content = extractTextFromHTML(content);
        
        // Extract title from HTML if available
        const titleMatch = content.match(/<title>(.*?)<\/title>/i);
        if (titleMatch) {
          title = titleMatch[1].trim();
        }
      }
    } else {
      // Read from local file
      const filePath = isAbsolute(urlOrPath) ? urlOrPath : join(process.cwd(), urlOrPath);
      
      if (!existsSync(filePath)) {
        throw new Error(`Documentation file not found: ${filePath}`);
      }
      
      content = await readFile(filePath, "utf-8");
      
      // Extract title from markdown if it's a .md file
      if (filePath.endsWith(".md")) {
        const titleMatch = content.match(/^#\s+(.+)$/m);
        if (titleMatch) {
          title = titleMatch[1].trim();
        }
      }
      
      // Use filename as title if no title found
      if (!title) {
        const fileName = filePath.split("/").pop() || filePath.split("\\").pop();
        title = fileName?.replace(/\.[^/.]+$/, "") || urlOrPath;
      }
    }

    // Log removed to avoid interfering with MCP JSON protocol
    // log(`Fetched ${content.length} characters from documentation`);

    return {
      url: urlOrPath,
      title,
      content: content.trim(),
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    logError(`Error fetching documentation from ${urlOrPath}:`, error);
    throw error;
  }
}

/**
 * Extract text content from HTML
 */
function extractTextFromHTML(html: string): string {
  // Remove script and style tags
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  
  // Convert HTML entities
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  
  // Remove HTML tags but preserve structure with newlines
  text = text.replace(/<h[1-6][^>]*>/gi, "\n\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n");
  text = text.replace(/<p[^>]*>/gi, "\n\n");
  text = text.replace(/<\/p>/gi, "");
  text = text.replace(/<br[^>]*>/gi, "\n");
  text = text.replace(/<div[^>]*>/gi, "\n");
  text = text.replace(/<\/div>/gi, "");
  text = text.replace(/<li[^>]*>/gi, "\n- ");
  text = text.replace(/<\/li>/gi, "");
  text = text.replace(/<ul[^>]*>/gi, "\n");
  text = text.replace(/<\/ul>/gi, "\n");
  text = text.replace(/<ol[^>]*>/gi, "\n");
  text = text.replace(/<\/ol>/gi, "\n");
  
  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");
  
  // Clean up whitespace
  text = text.replace(/\n\s*\n\s*\n/g, "\n\n");
  text = text.replace(/[ \t]+/g, " ");
  text = text.trim();
  
  return text;
}

/**
 * Crawl all documentation pages from a base URL
 * Follows links and fetches all pages under the docs path
 * Checks cache for individual pages before fetching
 */
export async function crawlDocumentation(baseUrl: string, maxPages = 100, useCache = true): Promise<DocumentationContent[]> {
  // Log removed to avoid interfering with MCP JSON protocol
  // log(`Crawling documentation from: ${baseUrl} (max ${maxPages} pages)`);
  
  const storage = useCache ? getStorage() : null;
  const visited = new Set<string>();
  const toVisit: string[] = [baseUrl];
  const results: DocumentationContent[] = [];
  
  while (toVisit.length > 0 && visited.size < maxPages) {
    const currentUrl = toVisit.shift()!;
    
    if (visited.has(currentUrl)) {
      continue;
    }
    
    visited.add(currentUrl);
    
    // Check cache first
    if (storage) {
      const cached = await storage.getDocumentation(currentUrl);
      if (cached) {
        results.push(cached);
        // Still extract links from cached content to discover new pages
        // For now, we'll need to fetch the HTML to extract links, but we can optimize this later
        // by storing links in the cache or parsing from cached content
        try {
          const response = await fetch(currentUrl, {
            headers: {
              "User-Agent": "Discord-MCP-Bot/1.0",
            },
          });
          if (response.ok) {
            const rawHtml = await response.text();
            const links = extractLinksFromHTML(rawHtml, baseUrl);
            for (const link of links) {
              const normalizedLink = link.split("#")[0].replace(/\/$/, "");
              if (normalizedLink.startsWith(baseUrl.replace(/\/$/, "")) && 
                  !visited.has(normalizedLink) && 
                  !toVisit.includes(normalizedLink)) {
                toVisit.push(normalizedLink);
              }
            }
          }
        } catch (error) {
          // If we can't fetch for link extraction, continue with cached content
        }
        continue;
      }
    }
    
    try {
      // Log removed to avoid interfering with MCP JSON protocol
      // log(`Fetching: ${currentUrl} (${visited.size}/${maxPages})`);
      
      // Fetch raw HTML first to extract links
      const response = await fetch(currentUrl, {
        headers: {
          "User-Agent": "Discord-MCP-Bot/1.0",
        },
      });

      if (!response.ok) {
        logError(`Failed to fetch ${currentUrl}: ${response.status} ${response.statusText}`);
        continue;
      }

      const contentType = response.headers.get("content-type") || "";
      const rawHtml = await response.text();
      
      // Extract links from raw HTML before processing
      const links = extractLinksFromHTML(rawHtml, baseUrl);
      for (const link of links) {
        // Normalize the link (remove fragments, trailing slashes)
        const normalizedLink = link.split("#")[0].replace(/\/$/, "");
        // Only follow links that are under the docs path
        if (normalizedLink.startsWith(baseUrl.replace(/\/$/, "")) && 
            !visited.has(normalizedLink) && 
            !toVisit.includes(normalizedLink)) {
          toVisit.push(normalizedLink);
        }
      }
      
      // Now process the content for the documentation
      let content = rawHtml;
      let title: string | undefined;
      
      if (contentType.includes("text/html")) {
        // Extract title before processing HTML
        const titleMatch = rawHtml.match(/<title>(.*?)<\/title>/i);
        if (titleMatch) {
          title = titleMatch[1].trim();
        }
        
        content = extractTextFromHTML(rawHtml);
      }
      
      const doc: DocumentationContent = {
        url: currentUrl,
        title,
        content: content.trim(),
        fetched_at: new Date().toISOString(),
      };
      
      results.push(doc);
      
      // Cache immediately
      if (storage) {
        try {
          await storage.saveDocumentation(doc);
        } catch (error) {
          // Continue even if caching fails
        }
      }
      
    } catch (error) {
      logError(`Failed to fetch ${currentUrl}:`, error);
    }
    
    // Small delay to be respectful (only for actual fetches, not cached)
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  // Log removed to avoid interfering with MCP JSON protocol
  // log(`Crawled ${results.length} documentation pages`);
  return results;
}

/**
 * Extract links from HTML content
 */
function extractLinksFromHTML(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    
    // Skip anchors, mailto, tel, etc.
    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) {
      continue;
    }
    
    // Resolve relative URLs
    try {
      const resolvedUrl = new URL(href, baseUrl);
      const baseUrlObj = new URL(baseUrl);
      
      // Only include links that are on the same domain and under /docs path
      if (resolvedUrl.hostname === baseUrlObj.hostname && 
          (resolvedUrl.pathname.startsWith("/docs") || resolvedUrl.pathname.startsWith(baseUrlObj.pathname))) {
        links.push(resolvedUrl.href);
      }
    } catch {
      // Invalid URL, skip
    }
  }
  
  return [...new Set(links)]; // Remove duplicates
}

/**
 * Fetch multiple documentation URLs or crawl docs directories
 * If a URL ends with /docs, it will crawl all pages under it
 * Uses cached documentation if available, otherwise fetches and caches
 */
export async function fetchMultipleDocumentation(urls: string[], crawlDocs = true, useCache = true): Promise<DocumentationContent[]> {
  const storage = getStorage();
  const results: DocumentationContent[] = [];
  const urlsToFetch: string[] = [];
  
  // Check cache first if enabled
  if (useCache) {
    const cachedDocs = await storage.getDocumentationMultiple(urls);
    const cachedUrls = new Set(cachedDocs.map(d => d.url));
    
    // Add cached docs to results
    results.push(...cachedDocs);
    
    // Find URLs that need to be fetched
    for (const urlOrPath of urls) {
      if (!cachedUrls.has(urlOrPath)) {
        urlsToFetch.push(urlOrPath);
      }
    }
  } else {
    urlsToFetch.push(...urls);
  }
  
  // Fetch missing documentation
  const fetchedDocs: DocumentationContent[] = [];
  for (const urlOrPath of urlsToFetch) {
    try {
      // Check if it's a docs directory URL that should be crawled
      if (crawlDocs && urlOrPath.startsWith("http") && (urlOrPath.endsWith("/docs") || urlOrPath.includes("/docs/"))) {
        // Log removed to avoid interfering with MCP JSON protocol
        // log(`Crawling docs directory: ${urlOrPath}`);
        const crawledDocs = await crawlDocumentation(urlOrPath);
        fetchedDocs.push(...crawledDocs);
      } else {
        // Single page fetch
        const doc = await fetchDocumentation(urlOrPath);
        fetchedDocs.push(doc);
      }
    } catch (error) {
      logError(`Failed to fetch ${urlOrPath}:`, error);
    }
  }
  
  // Cache fetched documentation
  if (fetchedDocs.length > 0 && useCache) {
    try {
      await storage.saveDocumentationMultiple(fetchedDocs);
    } catch (error) {
      logError("Failed to cache documentation:", error);
      // Continue even if caching fails
    }
  }
  
  // Combine cached and fetched results
  results.push(...fetchedDocs);
  
  return results;
}

