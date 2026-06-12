/**
 * Provider-agnostic embedding generation. The single entry point all
 * higher-level code uses to turn text into vectors.
 *
 * Default: local Ollama. No per-token cost, no rate limits, no API key
 * required for the agent to keep its persistent code/issue/memory caches
 * warm. Setting `EMBEDDING_PROVIDER=openai` falls back to OpenAI's API.
 *
 * Whichever provider is selected, the rest of the system sees the same
 * `embedTexts(string[]) → Promise<number[][]>` shape. The dimension is fixed
 * at `EMBEDDING_DIM` (vector.ts) and must match the model's output — Ollama
 * verifies this on the first batch and throws a clear error if mismatched.
 */

import { EMBEDDING_DIM } from "../storage/db/vector.js";

export type Embedding = number[];

const MAX_INPUT_CHARS = 6000;

interface ProviderConfig {
  provider: "ollama" | "openai";
  ollamaBaseUrl: string;
  ollamaModel: string;
  openaiModel: string;
  openaiApiKey?: string;
}

function getProviderConfig(opts?: { apiKey?: string }): ProviderConfig {
  const v = (process.env.EMBEDDING_PROVIDER ?? "ollama").toLowerCase();
  return {
    provider: v === "openai" ? "openai" : "ollama",
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    ollamaModel: process.env.OLLAMA_EMBEDDING_MODEL ?? "mxbai-embed-large",
    openaiModel: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    openaiApiKey: opts?.apiKey ?? process.env.OPENAI_API_KEY,
  };
}

/**
 * The "model" identifier we persist alongside every embedding row, so we know
 * which provider/model produced each stored vector.
 */
export function getActiveEmbeddingModel(): string {
  const cfg = getProviderConfig();
  return cfg.provider === "ollama" ? `ollama:${cfg.ollamaModel}` : cfg.openaiModel;
}

/**
 * Embed a batch of texts. Order-preserving: result[i] is the embedding of
 * input[i]. Inputs longer than ~1.5k tokens are truncated.
 *
 * Ollama processes inputs sequentially internally, but the request batches
 * over a single HTTP round-trip. ~12k code files on a laptop GPU finishes in
 * ~5-15 minutes; on CPU more like 30-60. Run the re-embed script overnight
 * after a model swap.
 */
export async function embedTexts(
  texts: string[],
  opts?: { apiKey?: string; retries?: number },
): Promise<Embedding[]> {
  if (texts.length === 0) return [];
  const cfg = getProviderConfig(opts);
  const inputs = texts.map((t) => (t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t));
  const retries = opts?.retries ?? 3;
  return cfg.provider === "ollama"
    ? embedWithOllama(inputs, cfg, retries)
    : embedWithOpenAI(inputs, cfg, retries);
}

export async function embedText(
  text: string,
  opts?: { apiKey?: string; retries?: number },
): Promise<Embedding> {
  const [vec] = await embedTexts([text], opts);
  if (!vec) throw new Error("Embedding provider returned empty result");
  return vec;
}

async function embedWithOllama(
  inputs: string[],
  cfg: ProviderConfig,
  retries: number,
): Promise<Embedding[]> {
  const url = `${cfg.ollamaBaseUrl.replace(/\/$/, "")}/api/embed`;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg.ollamaModel, input: inputs }),
      });
      if (!res.ok) {
        throw new Error(`Ollama API error ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as { embeddings?: number[][] };
      const embeddings = data.embeddings ?? [];
      if (embeddings.length !== inputs.length) {
        throw new Error(
          `Ollama returned ${embeddings.length} embeddings for ${inputs.length} inputs`,
        );
      }
      const dim = embeddings[0]?.length;
      if (dim && dim !== EMBEDDING_DIM) {
        throw new Error(
          `Ollama model "${cfg.ollamaModel}" returned ${dim}-dim vectors but ` +
            `EMBEDDING_DIM is ${EMBEDDING_DIM}. Update src/storage/db/vector.ts ` +
            `and write a halfvec(${dim}) migration before using this model.`,
        );
      }
      return embeddings;
    } catch (err) {
      if (attempt === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
  }
  throw new Error("Ollama embedding failed after retries");
}

async function embedWithOpenAI(
  inputs: string[],
  cfg: ProviderConfig,
  retries: number,
): Promise<Embedding[]> {
  if (!cfg.openaiApiKey) {
    throw new Error("EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY");
  }
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.openaiApiKey}`,
        },
        body: JSON.stringify({ model: cfg.openaiModel, input: inputs }),
      });
      if (!res.ok) {
        if (res.status === 429 && attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 2000));
          continue;
        }
        throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
      return (data.data ?? []).map((d) => d.embedding);
    } catch (err) {
      if (attempt === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
  }
  throw new Error("OpenAI embedding failed after retries");
}

/**
 * Human-readable description of the active provider, for warnings that get
 * surfaced to agents/users (e.g. "Ollama (http://localhost:11434, model
 * mxbai-embed-large)").
 */
export function describeEmbeddingProvider(): string {
  const cfg = getProviderConfig();
  return cfg.provider === "ollama"
    ? `Ollama (${cfg.ollamaBaseUrl}, model ${cfg.ollamaModel})`
    : `OpenAI (model ${cfg.openaiModel})`;
}

/**
 * Cheap reachability probe. Used by code paths that gracefully degrade
 * when no provider is reachable; not used in the write hot path because
 * `embedTexts` already throws a clear error if the provider is down.
 */
export async function isEmbeddingProviderAvailable(): Promise<boolean> {
  const cfg = getProviderConfig();
  if (cfg.provider === "openai") return Boolean(cfg.openaiApiKey);
  try {
    const res = await fetch(`${cfg.ollamaBaseUrl.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}
