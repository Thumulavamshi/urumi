// Minimal client for an OpenAI-compatible chat-completions API with tool
// calling (Groq by default). Plain fetch, no SDK: one endpoint, and the request
// and response shapes are small enough to type by hand.
import type { ChatConfig } from "./config.ts";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type LlmMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface LlmTool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface Completion {
  message: { content: string | null; tool_calls?: ToolCall[] };
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export class LlmError extends Error {
  status: number;
  /** Seconds until a rate limit resets, when the provider says. */
  retryAfter?: number;
  /** Provider error code, e.g. "tool_use_failed". */
  code?: string;
  constructor(status: number, message: string, opts: { retryAfter?: number; code?: string } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = opts.retryAfter;
    this.code = opts.code;
  }
}

/** "2m52.8s" / "577ms" / "7.5s" / "12" -> seconds */
function parseDuration(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  let seconds = 0;
  for (const [, n, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    seconds += Number(n) * ({ h: 3600, m: 60, s: 1, ms: 0.001 } as Record<string, number>)[unit!]!;
  }
  return seconds || undefined;
}

export class LlmClient {
  readonly model: string;
  #cfg: ChatConfig;

  constructor(cfg: ChatConfig) {
    this.#cfg = cfg;
    this.model = cfg.model;
  }

  async complete(messages: LlmMessage[], tools: LlmTool[], signal: AbortSignal): Promise<Completion> {
    const res = await fetch(`${this.#cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.#cfg.model,
        messages,
        ...(tools.length ? { tools, tool_choice: "auto", parallel_tool_calls: false } : {}),
        temperature: 0.2,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#cfg.timeoutMs)]),
    });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const message: string = body?.error?.message ?? `HTTP ${res.status}`;
      const retryAfter = parseDuration(res.headers.get("retry-after")) ?? parseDuration(res.headers.get("x-ratelimit-reset-tokens"));
      throw new LlmError(res.status, message, { retryAfter, code: body?.error?.code });
    }
    const choice = body?.choices?.[0];
    if (!choice?.message) throw new LlmError(502, "LLM returned no message");
    return { message: choice.message, usage: body.usage };
  }
}
