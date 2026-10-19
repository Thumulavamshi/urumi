// Audit log: one row per tool call through the gateway (MCP clients and, from
// Phase 6, the chat agent). Admins see everyone; members only themselves —
// enforced by the API, the UI just hides the user filter.
import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { get, type AuditPage as Page, type Me, type Outcome, type Server, type User } from "../api.ts";
import { Badge, dateTime, Empty, ErrorText, OutcomeBadge } from "../ui.tsx";

const OUTCOMES: Outcome[] = ["success", "error", "timeout", "unreachable", "denied"];

interface Filters {
  userId: string;
  server: string;
  tool: string;
  outcome: string;
  via: string;
  from: string;
  to: string;
}
const EMPTY: Filters = { userId: "", server: "", tool: "", outcome: "", via: "", from: "", to: "" };

export function AuditPage({ me }: { me: Me }) {
  const isAdmin = me.role === "admin";
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [live, setLive] = useState(true);
  const set = (key: keyof Filters) => (e: { target: { value: string } }) => setFilters({ ...filters, [key]: e.target.value });

  const users = useQuery({ queryKey: ["users"], queryFn: () => get<User[]>("/users"), enabled: isAdmin });
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => get<Server[]>("/servers") });

  const audit = useInfiniteQuery({
    queryKey: ["audit", filters],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: "50" });
      for (const [k, v] of Object.entries(filters)) {
        if (!v) continue;
        // datetime-local has no zone: interpret it in the viewer's timezone.
        q.set(k, k === "from" || k === "to" ? new Date(v).toISOString() : v);
      }
      if (pageParam) q.set("before", String(pageParam));
      return get<Page>(`/audit?${q}`);
    },
    getNextPageParam: (last) => last.nextBefore,
    refetchInterval: live ? 5000 : false,
  });
  const rows = audit.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = Object.values(filters).some(Boolean);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="muted">{isAdmin ? "Every tool call through the gateway, by everyone." : "Your tool calls through the gateway."}</p>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          Auto-refresh
        </label>
      </header>

      <section className="card filters">
        {isAdmin && (
          <label className="field">
            <span>User</span>
            <select value={filters.userId} onChange={set("userId")}>
              <option value="">All users</option>
              {users.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>Server</span>
          <select value={filters.server} onChange={set("server")}>
            <option value="">All servers</option>
            {servers.data?.map((s) => (
              <option key={s.id} value={s.slug}>
                {s.slug}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Tool contains</span>
          <input value={filters.tool} onChange={set("tool")} placeholder="list_orders" />
        </label>
        <label className="field">
          <span>Outcome</span>
          <select value={filters.outcome} onChange={set("outcome")}>
            <option value="">Any</option>
            {OUTCOMES.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Via</span>
          <select value={filters.via} onChange={set("via")}>
            <option value="">Any</option>
            <option value="mcp">MCP client</option>
            <option value="chat">Chat</option>
          </select>
        </label>
        <label className="field">
          <span>From</span>
          <input type="datetime-local" value={filters.from} onChange={set("from")} />
        </label>
        <label className="field">
          <span>To</span>
          <input type="datetime-local" value={filters.to} onChange={set("to")} />
        </label>
        {filtered && (
          <button className="btn btn-small align-end" onClick={() => setFilters(EMPTY)}>
            Clear
          </button>
        )}
      </section>

      <ErrorText error={audit.error} />
      <section className="card">
        {audit.data && rows.length === 0 && <Empty>{filtered ? "No calls match these filters." : "No tool calls yet."}</Empty>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  {isAdmin && <th>User</th>}
                  <th>Server</th>
                  <th>Tool</th>
                  <th>Via</th>
                  <th className="right">Duration</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{dateTime(r.at)}</td>
                    {isAdmin && <td>{r.userEmail}</td>}
                    <td>{r.server ?? <span className="muted">—</span>}</td>
                    <td>
                      <code>{r.tool}</code>
                      {r.error && <div className="error small">{r.error}</div>}
                    </td>
                    <td>
                      <Badge tone={r.via === "chat" ? "info" : "muted"}>{r.via}</Badge>
                    </td>
                    <td className="right nowrap">{r.durationMs} ms</td>
                    <td>
                      <OutcomeBadge outcome={r.outcome} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {audit.hasNextPage && (
          <button className="btn" onClick={() => audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
            {audit.isFetchingNextPage ? "Loading…" : "Load older"}
          </button>
        )}
      </section>
    </>
  );
}
