// Upstream MCP servers: everyone sees status and tools; admins add/edit/
// enable/disable/delete and test connections. Credentials are write-only: the
// form can set or replace one but never shows the stored value.
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, get, type AuthType, type Me, type Server, type TestResult } from "../api.ts";
import { ago, Badge, Empty, ErrorText, Modal, StatusBadge } from "../ui.tsx";

export function ServersPage({ me }: { me: Me }) {
  const isAdmin = me.role === "admin";
  // Status changes (an upstream going down) show up within a few seconds.
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => get<Server[]>("/servers"), refetchInterval: 5000 });
  const [editing, setEditing] = useState<Server | "new" | null>(null);

  const connected = servers.data?.filter((s) => s.status === "connected") ?? [];
  const toolCount = connected.reduce((n, s) => n + s.tools.length, 0);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Servers</h1>
          <p className="muted">
            Upstream MCP servers behind the gateway.{" "}
            {servers.data && (
              <>
                {connected.length} of {servers.data.length} connected · {toolCount} tools available to clients
              </>
            )}
          </p>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            Add server
          </button>
        )}
      </header>

      <ErrorText error={servers.error} />
      {servers.data?.length === 0 && <Empty>No servers yet.</Empty>}
      <div className="stack">
        {servers.data?.map((s) => (
          <ServerCard key={s.id} server={s} isAdmin={isAdmin} onEdit={() => setEditing(s)} />
        ))}
      </div>

      {editing && <ServerForm server={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ServerCard({ server: s, isAdmin, onEdit }: { server: Server; isAdmin: boolean; onEdit: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["servers"] });
  const toggle = useMutation({
    mutationFn: () => api("PATCH", `/servers/${s.id}`, { enabled: !s.enabled }),
    onSettled: refresh,
  });
  const runTest = useMutation({
    mutationFn: () => api<TestResult>("POST", `/servers/${s.id}/test`),
    onSuccess: setTest,
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api("DELETE", `/servers/${s.id}`),
    onSettled: refresh,
  });

  return (
    <section className={`card server ${s.enabled ? "" : "server-off"}`}>
      <div className="server-head">
        <div className="server-title">
          <h2>{s.name}</h2>
          <code className="slug">{s.slug}</code>
          <StatusBadge status={s.status} />
          {s.managed && (
            <Badge tone="info" title="Registered from Helm values: URL and credential are changed there">
              managed
            </Badge>
          )}
        </div>
        {isAdmin && (
          <div className="actions">
            <button className="btn btn-small" onClick={() => runTest.mutate()} disabled={runTest.isPending}>
              {runTest.isPending ? "Testing…" : "Test"}
            </button>
            <button className="btn btn-small" onClick={onEdit}>
              Edit
            </button>
            <button className="btn btn-small" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
              {s.enabled ? "Disable" : "Enable"}
            </button>
            {!s.managed && (
              <button
                className="btn btn-small btn-danger"
                disabled={remove.isPending}
                onClick={() => confirm(`Delete server "${s.name}"? Its tools disappear for everyone.`) && remove.mutate()}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      <dl className="meta">
        <div>
          <dt>URL</dt>
          <dd>
            <code>{s.url}</code>
          </dd>
        </div>
        <div>
          <dt>Auth</dt>
          <dd>
            {s.authType === "none" ? "none" : s.authType === "bearer" ? "Bearer token" : `Header ${s.authHeaderName}`}
            {s.authType !== "none" && <span className="muted"> · {s.hasCredential ? "credential stored (encrypted)" : "no credential"}</span>}
          </dd>
        </div>
        <div>
          <dt>Checked</dt>
          <dd>{ago(s.lastCheckedAt)}</dd>
        </div>
      </dl>

      {s.status === "unreachable" && s.lastError && <p className="error">Reason: {s.lastError}</p>}
      {test && (
        <p className={test.ok ? "success" : "error"}>
          Test: {test.ok ? `connected, ${test.tools.length} tools (${test.tools.join(", ")})` : test.error}
        </p>
      )}
      <ErrorText error={toggle.error ?? remove.error ?? runTest.error} />

      {s.tools.length > 0 && (
        <div className="tools">
          <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "▾" : "▸"} {s.tools.length} tools
          </button>
          {open && (
            <table className="table tools-table">
              <thead>
                <tr>
                  <th>Exposed to clients as</th>
                  <th>Description</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {s.tools.map((t) => (
                  <tr key={t.name}>
                    <td>
                      <code>{t.exposedAs}</code>
                    </td>
                    <td className="muted">{t.description}</td>
                    <td className="nowrap">
                      {t.readOnly ? <Badge tone="muted">read-only</Badge> : <Badge tone="warn">writes</Badge>}{" "}
                      {t.adminOnly && <Badge tone="info">admin only</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

function ServerForm({ server, onClose }: { server: Server | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = server === null;
  const locked = server?.managed ?? false; // managed: only the name is editable here
  const [slug, setSlug] = useState(server?.slug ?? "");
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [authType, setAuthType] = useState<AuthType>(server?.authType ?? "none");
  const [headerName, setHeaderName] = useState(server?.authHeaderName ?? "");
  const [credential, setCredential] = useState(""); // empty = keep the stored one
  const [test, setTest] = useState<TestResult | null>(null);

  const needsCredential = authType !== "none" && (isNew || !server?.hasCredential || server.authType === "none");

  const runTest = useMutation({
    mutationFn: () =>
      api<TestResult>("POST", "/servers/test", {
        slug: slug || "test",
        url,
        authType,
        authHeaderName: authType === "header" ? headerName : undefined,
        credential: credential || undefined,
        serverId: server?.id, // reuse the stored credential if none was typed
      }),
    onSuccess: setTest,
  });

  const save = useMutation({
    mutationFn: () => {
      if (isNew) {
        return api("POST", "/servers", {
          slug,
          name,
          url,
          authType,
          authHeaderName: authType === "header" ? headerName : undefined,
          credential: authType === "none" ? undefined : credential,
        });
      }
      if (locked) return api("PATCH", `/servers/${server.id}`, { name });
      return api("PATCH", `/servers/${server.id}`, {
        name,
        url,
        authType,
        authHeaderName: authType === "header" ? headerName : null,
        ...(credential ? { credential } : {}),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["servers"] });
      onClose();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <Modal title={isNew ? "Add server" : `Edit ${server.name}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {locked && (
          <p className="note">
            This server is managed by Helm values: its URL and credential are set in the chart. You can rename it, or enable/disable it from the list.
          </p>
        )}
        <div className="row">
          <label className="field">
            <span>Slug (tool prefix)</span>
            <input
              required
              disabled={!isNew}
              pattern="[a-z][a-z0-9\-]{0,29}"
              title="lowercase letters, digits and '-', starting with a letter"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="crm"
            />
          </label>
          <label className="field grow">
            <span>Display name</span>
            <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="CRM" />
          </label>
        </div>
        {slug && <p className="muted small">Tools will appear to clients as <code>{slug}__&lt;tool&gt;</code>.</p>}
        <label className="field">
          <span>MCP endpoint URL (Streamable HTTP)</span>
          <input required type="url" disabled={locked} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://crm.tools.svc.cluster.local/mcp" />
        </label>
        <div className="row">
          <label className="field">
            <span>Authentication</span>
            <select disabled={locked} value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}>
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="header">Custom header</option>
            </select>
          </label>
          {authType === "header" && (
            <label className="field grow">
              <span>Header name</span>
              <input required disabled={locked} value={headerName} onChange={(e) => setHeaderName(e.target.value)} placeholder="X-Api-Key" />
            </label>
          )}
        </div>
        {authType !== "none" && !locked && (
          <label className="field">
            <span>Credential {needsCredential ? "" : "(leave empty to keep the stored one)"}</span>
            <input
              type="password"
              autoComplete="off"
              required={needsCredential}
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder={server?.hasCredential ? "•••••••• stored" : ""}
            />
            <small className="muted">Stored encrypted. Nobody can read it back, including admins.</small>
          </label>
        )}

        {test && <p className={test.ok ? "success" : "error"}>{test.ok ? `Connected: ${test.tools.length} tools (${test.tools.join(", ")})` : test.error}</p>}
        <ErrorText error={save.error ?? runTest.error} />

        <footer className="modal-foot">
          {!locked && (
            <button type="button" className="btn" onClick={() => runTest.mutate()} disabled={!url || runTest.isPending}>
              {runTest.isPending ? "Testing…" : "Test connection"}
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : isNew ? "Add server" : "Save"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
