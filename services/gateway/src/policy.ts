// Per-role tool permissions. Admins may use every tool; members may use every
// tool except those matching `memberDeniedTools` (exposed names, "*" wildcard,
// e.g. "woo__update_order_status" or "notes__*").
//
// Enforced in one place for every path: denied tools are left out of the MCP
// `tools/list` and the chat agent's tool list, and `ToolRouter.call` rejects
// them if called anyway (a stale list, a hand-written request) — audited as
// "denied".
import type { Principal } from "./auth.ts";

export class ToolPolicy {
  #memberDenied: RegExp[];

  constructor(memberDeniedTools: string[]) {
    this.#memberDenied = memberDeniedTools
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
  }

  /** Tools only admins may use (shown as "admin only" in the dashboard). */
  adminOnly(tool: string): boolean {
    return this.#memberDenied.some((re) => re.test(tool));
  }

  allows(principal: Pick<Principal, "role">, tool: string): boolean {
    return principal.role === "admin" || !this.adminOnly(tool);
  }

  filter<T extends { name: string }>(principal: Pick<Principal, "role">, tools: T[]): T[] {
    return tools.filter((t) => this.allows(principal, t.name));
  }
}
