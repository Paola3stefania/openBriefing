/**
 * Minimal local stand-ins for @vercel/node's VercelRequest / VercelResponse.
 *
 * The api/ handlers are deployed as Vercel Serverless Functions; at runtime
 * Vercel supplies the actual request/response objects. We only ever touch a
 * tiny subset of that surface (headers, method, body; status().json()), so
 * defining the types locally lets us drop the heavy `@vercel/node` dependency
 * — and its deploy-time-only transitive CVEs (undici / minimatch /
 * path-to-regexp / smol-toml via @vercel/build-utils) — from the dependency
 * tree entirely, without changing any runtime behavior.
 */

export interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface VercelResponse {
  status(statusCode: number): VercelResponse;
  json(body: unknown): VercelResponse;
}
