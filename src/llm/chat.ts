/**
 * Provider-agnostic LLM chat completions. The single entry point for every
 * "ask an LLM to produce text/JSON" call in the codebase (feature extraction,
 * grouping, label detection, comment analysis, HTML→content parsing, ...).
 *
 * Default: local Ollama via its OpenAI-compatible `/v1/chat/completions`
 * endpoint. No per-token cost, no rate limits, no API key. Setting
 * `LLM_PROVIDER=openai` (or the shared `EMBEDDING_PROVIDER=openai`) routes to
 * OpenAI's hosted API instead.
 *
 * Both providers share the OpenAI request/response wire shape, so call sites
 * only need `llmChat(messages, opts) → Promise<string>` (the assistant message
 * content). JSON-mode is requested with `{ jsonMode: true }`.
 */

export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface LLMChatOptions {
  /** Ask the model for a JSON object (sets response_format json_object). */
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  retries?: number;
}

interface LLMProviderConfig {
  provider: "ollama" | "openai";
  ollamaBaseUrl: string;
  ollamaModel: string;
  openaiModel: string;
  openaiApiKey?: string;
}

function getLLMProviderConfig(): LLMProviderConfig {
  // Prefer LLM_PROVIDER; fall back to the shared EMBEDDING_PROVIDER so a single
  // `EMBEDDING_PROVIDER=openai` flips both embeddings and chat to OpenAI.
  const raw = (process.env.LLM_PROVIDER ?? process.env.EMBEDDING_PROVIDER ?? "ollama").toLowerCase();
  return {
    provider: raw === "openai" ? "openai" : "ollama",
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    ollamaModel: process.env.OLLAMA_CHAT_MODEL ?? "llama3.1",
    openaiModel: process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini",
    openaiApiKey: process.env.OPENAI_API_KEY,
  };
}

export function getLLMProvider(): "ollama" | "openai" {
  return getLLMProviderConfig().provider;
}

/**
 * A usable API key for the active LLM provider. Always returns a string so it
 * is a safe drop-in replacement for the codebase's many `process.env.OPENAI_API_KEY`
 * reads (both `if (!key) throw` guards and `fn(text, key)` arg-passing).
 *
 * For Ollama this returns a non-empty sentinel ("ollama-local") so legacy
 * `if (!apiKey) throw "OPENAI_API_KEY required"` guards pass without an OpenAI
 * key — the value is ignored by the Ollama request path. For OpenAI it returns
 * the real key, or "" when unset (so the same guards still fire, and the
 * provider call throws a clear "requires OPENAI_API_KEY" error).
 *
 * Prefer this over reading `process.env.OPENAI_API_KEY` directly so a single
 * provider switch flips behaviour everywhere.
 */
export function getLLMApiKey(): string {
  const cfg = getLLMProviderConfig();
  if (cfg.provider === "ollama") return "ollama-local";
  return cfg.openaiApiKey ?? "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a chat completion and return the assistant message content.
 *
 * Order-preserving messages in, string out. Throws a clear error if the
 * provider is unreachable or returns no content (after `retries` attempts).
 */
export async function llmChat(messages: ChatMessage[], opts: LLMChatOptions = {}): Promise<string> {
  const cfg = getLLMProviderConfig();
  const retries = opts.retries ?? 3;

  const baseUrl =
    cfg.provider === "ollama"
      ? `${cfg.ollamaBaseUrl.replace(/\/$/, "")}/v1`
      : "https://api.openai.com/v1";
  const model = cfg.provider === "ollama" ? cfg.ollamaModel : cfg.openaiModel;
  // Ollama's OpenAI-compatible endpoint ignores the bearer token, but the
  // header must be present; send a placeholder.
  const apiKey = cfg.provider === "ollama" ? "ollama" : cfg.openaiApiKey;
  if (cfg.provider === "openai" && !apiKey) {
    throw new Error("LLM_PROVIDER=openai requires OPENAI_API_KEY");
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (res.status === 429 && attempt < retries - 1) {
          await sleep(2 ** attempt * 2000);
          continue;
        }
        throw new Error(`${cfg.provider} chat error ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(`${cfg.provider} chat returned no content`);
      }
      return content;
    } catch (err) {
      if (attempt === retries - 1) throw err;
      await sleep(2 ** attempt * 1000);
    }
  }
  throw new Error("llmChat failed after retries");
}
