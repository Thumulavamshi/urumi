// Personal API keys: what an MCP client (Claude Code, Cursor, …) uses to reach
// the gateway as you. The full key is shown exactly once, right after creation.
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, get, type ApiKey, type NewKey } from "../api.ts";
import { ago, Badge, CodeBox, Empty, ErrorText, Modal } from "../ui.tsx";

export function KeysPage() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["my-keys"], queryFn: () => get<ApiKey[]>("/me/keys") });
  const [name, setName] = useState("");
  const [created, setCreated] = useState<NewKey | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  const create = useMutation({
    mutationFn: () => api<NewKey>("POST", "/me/keys", { name }),
    onSuccess: (k) => {
      setCreated(k);
      setName("");
      void qc.invalidateQueries({ queryKey: ["my-keys"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api("DELETE", `/keys/${id}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ["my-keys"] }),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  const visible = keys.data?.filter((k) => showRevoked || !k.revokedAt) ?? [];
  const revokedCount = keys.data?.filter((k) => k.revokedAt).length ?? 0;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>My API keys</h1>
          <p className="muted">
            One key per client or machine. A key acts as you: everything it calls is audited under your name. Revoking takes effect on the next request.
          </p>
        </div>
      </header>

      <form className="card row" onSubmit={submit}>
        <label className="field grow">
          <span>New key name</span>
          <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. laptop – Claude Code" />
        </label>
        <button className="btn btn-primary align-end" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create key"}
        </button>
      </form>
      <ErrorText error={create.error ?? revoke.error ?? keys.error} />

      <section className="card">
        {keys.data && visible.length === 0 && <Empty>No active keys. Create one to connect an MCP client.</Empty>}
        {visible.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Created</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((k) => (
                <tr key={k.id} className={k.revokedAt ? "row-off" : ""}>
                  <td>{k.name}</td>
                  <td>
                    <code>{k.prefix}…</code>
                  </td>
                  <td>{ago(k.createdAt)}</td>
                  <td>{ago(k.lastUsedAt)}</td>
                  <td className="right">
                    {k.revokedAt ? (
                      <Badge tone="muted">revoked {ago(k.revokedAt)}</Badge>
                    ) : (
                      <button
                        className="btn btn-small btn-danger"
                        disabled={revoke.isPending}
                        onClick={() => confirm(`Revoke "${k.name}"? Clients using it stop working immediately.`) && revoke.mutate(k.id)}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {revokedCount > 0 && (
          <button className="link-btn" onClick={() => setShowRevoked(!showRevoked)}>
            {showRevoked ? "Hide" : "Show"} {revokedCount} revoked
          </button>
        )}
      </section>

      {created && <NewKeyModal k={created} onClose={() => setCreated(null)} />}
    </>
  );
}

function NewKeyModal({ k, onClose }: { k: NewKey; onClose: () => void }) {
  const cursor = JSON.stringify(
    { mcpServers: { "urumi-gateway": { url: k.mcpUrl, headers: { Authorization: `Bearer ${k.key}` } } } },
    null,
    2,
  );
  return (
    <Modal title={`Key "${k.name}" created`} onClose={onClose}>
      <div className="stack">
        <p className="note">Copy it now. This is the only time the full key is shown; the gateway keeps just a hash.</p>
        <CodeBox value={k.key} />
        <h3>Claude Code</h3>
        <CodeBox value={k.claudeCode} />
        <h3>Cursor / other clients (mcp.json)</h3>
        <CodeBox value={cursor} />
        <p className="muted small">
          MCP endpoint: <code>{k.mcpUrl}</code> (Streamable HTTP, header <code>Authorization: Bearer &lt;key&gt;</code>)
        </p>
        <footer className="modal-foot">
          <span className="grow" />
          <button className="btn btn-primary" onClick={onClose}>
            I've copied it
          </button>
        </footer>
      </div>
    </Modal>
  );
}
