// Routes one aggregated tool call to its upstream and records it.
// Every call ends in exactly one audit row — success, error, timeout,
// denied or unreachable — attributed to the user who made it.
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { Principal } from "./auth.ts";
import type { Db } from "./db.ts";
import { errorMessage, log } from "./log.ts";
import { describeError, isTimeout, type UpstreamManager } from "./upstreams.ts";

export type Via = "mcp" | "chat";
type Outcome = "success" | "error" | "timeout" | "denied" | "unreachable";

export class ToolRouter {
  #db: Db;
  #upstreams: UpstreamManager;
  #timeoutMs: number;

  constructor(db: Db, upstreams: UpstreamManager, opts: { callTimeoutMs: number }) {
    this.#db = db;
    this.#upstreams = upstreams;
    this.#timeoutMs = opts.callTimeoutMs;
  }

  async call(
    principal: Principal,
    exposedName: string,
    args: Record<string, unknown> | undefined,
    via: Via,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const started = Date.now();
    const target = this.#upstreams.resolve(exposedName);
    let outcome: Outcome;
    let error: string | undefined;
    let result: CallToolResult;

    if (!target.ok) {
      outcome = target.outcome;
      error = target.error;
      result = errorResult(target.error);
    } else {
      try {
        result = (await target.client.callTool(
          { name: target.tool, arguments: args ?? {} },
          { timeout: this.#timeoutMs, signal },
        )) as CallToolResult;
        // The upstream answered; a tool-level error (isError) is still a routed call.
        outcome = result.isError ? "error" : "success";
        if (result.isError) error = firstText(result)?.slice(0, 500);
      } catch (err) {
        if (isTimeout(err)) {
          outcome = "timeout";
          error = `Upstream '${target.server.slug}' timed out after ${this.#timeoutMs / 1000}s`;
        } else {
          const reason = describeError(err, target.server.slug, this.#timeoutMs);
          const transportFailure = /refused|not found|reset|fetch failed/i.test(reason + errorMessage(err));
          outcome = transportFailure ? "unreachable" : "error";
          error = `Upstream '${target.server.slug}' failed: ${reason}`;
          if (transportFailure) this.#upstreams.recheckSoon(target.server.id);
        }
        result = errorResult(error);
      }
    }

    const server = target.server;
    await this.#db
      .query(
        `INSERT INTO audit_log (user_id, user_email, api_key_id, server_id, server_slug, tool, via, duration_ms, outcome, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          principal.id,
          principal.email,
          principal.apiKeyId ?? null,
          server?.id ?? null,
          server?.slug ?? null,
          exposedName,
          via,
          Date.now() - started,
          outcome,
          error ?? null,
        ],
      )
      .catch((err) => log({ msg: "AUDIT WRITE FAILED", tool: exposedName, user: principal.email, error: errorMessage(err) }));

    log({ msg: "tool call", user: principal.email, tool: exposedName, via, outcome, ms: Date.now() - started });
    return result;
  }
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function firstText(result: CallToolResult): string | undefined {
  const block = result.content?.find((c) => c.type === "text");
  return block && "text" in block ? block.text : undefined;
}
