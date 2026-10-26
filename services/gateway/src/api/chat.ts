// Chat agent: the dashboard's chat box, acting as the logged-in user.
//
//   GET  /api/chat/config   is chat enabled, which model
//   POST /api/chat          { messages: [{role, content}…] } -> Server-Sent Events
//
// The loop: send the conversation + the aggregated tool list to the LLM; if it
// asks for tools, run them and send the results back; repeat until it answers
// in text (or maxSteps). Tools run through exactly what /mcp uses —
// `upstreams.aggregatedTools()` for the list and `router.call()` for each call
// — with the logged-in user as the principal and via="chat". So the chat sees
// the same tools as that user's MCP clients, hits the same disabled/unreachable
// checks, and every call is audited under that user.
//
// Stateless: the browser keeps the transcript and sends it with each message.
import { Router, type Response } from "express";
import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import type { Principal } from "../auth.ts";
import type { ChatConfig } from "../config.ts";
import { LlmClient, LlmError, type LlmMessage, type LlmTool } from "../llm.ts";
import { errorMessage, log } from "../log.ts";
import type { ToolRouter } from "../router.ts";
import { HttpError } from "../auth.ts";
import { parse, type Deps } from "./util.ts";

const Body = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(8000) }))
    .min(1)
    .max(100)
    .refine((m) => m.at(-1)!.role === "user", "last message must be from the user"),
});

/** Only the most recent turns go to the LLM (the free tier allows ~8k tokens/minute). */
const HISTORY_TURNS = 12;
const RATE_LIMIT_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_S = 30;

type ChatEvent =
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; durationMs: number; preview: string }
  | { type: "status"; message: string }
  | { type: "message"; content: string }
  | { type: "error"; message: string }
  | { type: "done"; steps: number; tokens: number; model: string };

function systemPrompt(user: Principal): string {
  return [
    `You are the assistant for a small online store's team, working through the team's MCP gateway.`,
    `You are acting as ${user.name} <${user.email}> (role: ${user.role}). Every tool call you make is recorded in the audit log under their name.`,
    `Today is ${new Date().toISOString().slice(0, 10)} (UTC).`,
    `Tools are named <server>__<tool>: woo__* is the WooCommerce store, fx__* converts currencies, notes__* holds team follow-up notes. Tools with the same bare name on different servers do different things; pick by prefix.`,
    `Use tools to look things up instead of guessing; never invent orders, products, prices or rates. When asked to change something (create a product, update an order), do it and report what changed (ids, names, prices).`,
    `Exception: changes a customer can't easily undo — setting an order to refunded, cancelled or failed, or deleting anything — need explicit confirmation. Look the item up, say exactly what will change, and ask "Shall I go ahead?". Only make the change after the user confirms in a later message.`,
    `If a tool fails or a server is unreachable, say so plainly and don't pretend it worked.`,
    `Keep answers short and concrete. Use plain text or simple Markdown lists; show money with its currency.`,
  ].join("\n");
}

/** MCP tool -> OpenAI-style function. Drops "$schema", which some providers reject. */
function toLlmTool(t: Tool): LlmTool {
  const { $schema: _ignored, ...parameters } = t.inputSchema as Record<string, unknown>;
  return { type: "function", function: { name: t.name, description: t.description, parameters } };
}

function resultText(result: CallToolResult): string {
  const parts = (result.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type} content]`));
  return parts.join("\n") || (result.isError ? "error (no details)" : "ok (no output)");
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);

function sse(res: Response) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no", // don't let a proxy buffer the stream
    connection: "keep-alive",
  });
  res.flushHeaders();
  // Comment lines keep idle proxies from closing the stream during a long LLM call.
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
  return {
    send: (event: ChatEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`),
    end: () => {
      clearInterval(keepalive);
      res.end();
    },
  };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

function describeLlmError(err: unknown): string {
  if (err instanceof LlmError) {
    if (err.status === 401) return "The AI provider rejected the API key. An admin needs to update the platform-llm Secret.";
    if (err.status === 429) return `The AI provider's rate limit (free tier) was hit. Try again in ${Math.ceil(err.retryAfter ?? 60)}s.`;
    if (err.status === 413 || /too large|context length/i.test(err.message))
      return "The conversation got too long for the model. Start a new chat.";
    return `AI provider error (HTTP ${err.status}): ${err.message}`;
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "The AI provider didn't answer in time.";
  return `AI provider unreachable: ${errorMessage(err)}`;
}

export class ChatAgent {
  #llm: LlmClient;
  #cfg: ChatConfig;
  #deps: Pick<Deps, "upstreams">;
  #router: ToolRouter;

  constructor(cfg: ChatConfig, deps: Pick<Deps, "upstreams">, router: ToolRouter) {
    this.#cfg = cfg;
    this.#llm = new LlmClient(cfg);
    this.#deps = deps;
    this.#router = router;
  }

  get model() {
    return this.#llm.model;
  }

  async run(
    user: Principal,
    history: { role: "user" | "assistant"; content: string }[],
    send: (e: ChatEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const tools = this.#router.policy.filter(user, this.#deps.upstreams.aggregatedTools()).map(toLlmTool);
    const messages: LlmMessage[] = [{ role: "system", content: systemPrompt(user) }, ...history.slice(-HISTORY_TURNS)];
    let tokens = 0;

    for (let step = 1; step <= this.#cfg.maxSteps; step++) {
      const completion = await this.#complete(messages, tools, send, signal);
      tokens += completion.usage?.total_tokens ?? 0;
      const { content, tool_calls } = completion.message;

      if (!tool_calls?.length) {
        send({ type: "message", content: content?.trim() || "(no answer)" });
        send({ type: "done", steps: step, tokens, model: this.model });
        return;
      }

      messages.push({ role: "assistant", content: content ?? null, tool_calls });
      for (const call of tool_calls) {
        let args: Record<string, unknown> = {};
        let output: string;
        let ok = false;
        const started = Date.now();
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = { _raw: call.function.arguments };
        }
        send({ type: "tool_call", id: call.id, name: call.function.name, args });
        if ("_raw" in args) {
          output = "Invalid JSON in tool arguments; call the tool again with a valid JSON object.";
        } else {
          // Same routing, checks and audit as an MCP client's tools/call.
          const result = await this.#router.call(user, call.function.name, args, "chat", signal);
          output = resultText(result);
          ok = !result.isError;
        }
        send({ type: "tool_result", id: call.id, name: call.function.name, ok, durationMs: Date.now() - started, preview: truncate(output, 4000) });
        messages.push({ role: "tool", tool_call_id: call.id, content: truncate(output, this.#cfg.maxToolResultChars) });
      }
    }
    send({ type: "message", content: `I stopped after ${this.#cfg.maxSteps} tool steps without finishing. Try a narrower question.` });
    send({ type: "done", steps: this.#cfg.maxSteps, tokens, model: this.model });
  }

  /** One LLM round-trip, waiting out short rate limits and retrying a malformed tool call once. */
  async #complete(messages: LlmMessage[], tools: LlmTool[], send: (e: ChatEvent) => void, signal: AbortSignal) {
    let malformedRetried = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#llm.complete(messages, tools, signal);
      } catch (err) {
        if (err instanceof LlmError && err.status === 429 && attempt < RATE_LIMIT_RETRIES) {
          const wait = Math.min(Math.ceil(err.retryAfter ?? 10), MAX_RATE_LIMIT_WAIT_S);
          log({ msg: "llm rate limited, retrying", waitS: wait, attempt: attempt + 1 });
          send({ type: "status", message: `AI provider rate limit (free tier): retrying in ${wait}s…` });
          await sleep(wait * 1000, signal);
          continue;
        }
        // Groq rejects a generation whose tool call didn't parse; one retry usually fixes it.
        if (err instanceof LlmError && err.code === "tool_use_failed" && !malformedRetried) {
          malformedRetried = true;
          log({ msg: "llm produced a malformed tool call, retrying once" });
          continue;
        }
        throw err;
      }
    }
  }
}

export function chatRoutes(agent: ChatAgent | undefined): Router {
  const r = Router();
  const active = new Set<number>(); // one running reply per user

  r.get("/chat/config", (_req, res) => {
    res.json(agent ? { enabled: true, model: agent.model } : { enabled: false, model: null });
  });

  r.post("/chat", async (req, res) => {
    if (!agent) throw new HttpError(503, "chat is not configured (no LLM API key)");
    const { messages } = parse(Body, req.body);
    const user = req.principal!;
    if (active.has(user.id)) throw new HttpError(429, "a reply is already being generated for you; wait for it to finish");
    active.add(user.id);

    // Stop the LLM loop and any in-flight tool call if the browser goes away.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort(new Error("client disconnected"));
    });

    const stream = sse(res);
    const started = Date.now();
    try {
      await agent.run(user, messages, stream.send, abort.signal);
    } catch (err) {
      if (!abort.signal.aborted) {
        const message = describeLlmError(err);
        log({ msg: "chat failed", user: user.email, error: errorMessage(err) });
        stream.send({ type: "error", message });
      }
    } finally {
      active.delete(user.id);
      log({ msg: "chat reply", user: user.email, ms: Date.now() - started, aborted: abort.signal.aborted });
      stream.end();
    }
  });

  return r;
}
