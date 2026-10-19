// Team (admin only): invite people, change roles, disable accounts, and see or
// revoke anyone's API keys. There is no email sending: the admin copies the
// one-time invite link and passes it on.
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, get, type InviteLink, type Me, type Role, type User } from "../api.ts";
import { ago, Badge, CodeBox, ErrorText, Modal } from "../ui.tsx";

export function TeamPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => get<User[]>("/users") });
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<{ email: string; invite: InviteLink } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });

  const update = useMutation({
    mutationFn: ({ id, ...patch }: { id: number; role?: Role; disabled?: boolean }) => api("PATCH", `/users/${id}`, patch),
    onSettled: refresh,
  });
  const reinvite = useMutation({
    mutationFn: (u: User) => api<InviteLink>("POST", `/users/${u.id}/invite`).then((invite) => ({ email: u.email, invite })),
    onSuccess: setLink,
  });
  const revoke = useMutation({
    mutationFn: (keyId: number) => api("DELETE", `/keys/${keyId}`),
    onSettled: refresh,
  });

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Team</h1>
          <p className="muted">Admins manage servers and the team; members use the gateway with their own keys.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setInviting(true)}>
          Invite member
        </button>
      </header>
      <ErrorText error={users.error ?? update.error ?? reinvite.error ?? revoke.error} />

      <div className="stack">
        {users.data?.map((u) => {
          const self = u.id === me.id;
          const activeKeys = u.keys.filter((k) => !k.revokedAt);
          return (
            <section key={u.id} className={`card user ${u.disabledAt ? "server-off" : ""}`}>
              <div className="server-head">
                <div className="server-title">
                  <h2>{u.name}</h2>
                  <span className="muted">{u.email}</span>
                  {self && <Badge tone="info">you</Badge>}
                  {u.disabledAt ? (
                    <Badge tone="muted">disabled</Badge>
                  ) : u.invitePending ? (
                    <Badge tone="warn">invite pending</Badge>
                  ) : (
                    <Badge tone="ok">active</Badge>
                  )}
                </div>
                <div className="actions">
                  <select
                    aria-label="Role"
                    value={u.role}
                    disabled={self || update.isPending}
                    title={self ? "You can't change your own role" : undefined}
                    onChange={(e) => update.mutate({ id: u.id, role: e.target.value as Role })}
                  >
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                  {!u.disabledAt && (
                    <button className="btn btn-small" onClick={() => reinvite.mutate(u)} disabled={reinvite.isPending}>
                      {u.invitePending ? "New invite link" : "Password reset link"}
                    </button>
                  )}
                  {!self && (
                    <button
                      className={`btn btn-small ${u.disabledAt ? "" : "btn-danger"}`}
                      disabled={update.isPending}
                      onClick={() =>
                        u.disabledAt
                          ? update.mutate({ id: u.id, disabled: false })
                          : confirm(`Disable ${u.email}? They are logged out and all their keys stop working.`) &&
                            update.mutate({ id: u.id, disabled: true })
                      }
                    >
                      {u.disabledAt ? "Enable" : "Disable"}
                    </button>
                  )}
                </div>
              </div>
              {activeKeys.length === 0 ? (
                <p className="muted small">No active API keys · joined {ago(u.createdAt)}</p>
              ) : (
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th>Name</th>
                      <th>Created</th>
                      <th>Last used</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {activeKeys.map((k) => (
                      <tr key={k.id}>
                        <td>
                          <code>{k.prefix}…</code>
                        </td>
                        <td>{k.name}</td>
                        <td>{ago(k.createdAt)}</td>
                        <td>{ago(k.lastUsedAt)}</td>
                        <td className="right">
                          <button
                            className="btn btn-small btn-danger"
                            disabled={revoke.isPending}
                            onClick={() => confirm(`Revoke ${u.email}'s key "${k.name}"?`) && revoke.mutate(k.id)}
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      </div>

      {inviting && (
        <InviteForm
          onClose={() => setInviting(false)}
          onCreated={(email, invite) => {
            setInviting(false);
            setLink({ email, invite });
            void refresh();
          }}
        />
      )}
      {link && (
        <Modal title="Invite link" onClose={() => setLink(null)}>
          <div className="stack">
            <p>
              Send this link to <strong>{link.email}</strong>. It works once and expires {new Date(link.invite.expiresAt).toLocaleString()}.
            </p>
            <CodeBox value={link.invite.inviteUrl} />
            <p className="muted small">It's shown only now. Lost it? Create a new one from the team list; the old link stops working.</p>
            <footer className="modal-foot">
              <span className="grow" />
              <button className="btn btn-primary" onClick={() => setLink(null)}>
                Done
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </>
  );
}

function InviteForm({ onClose, onCreated }: { onClose: () => void; onCreated: (email: string, invite: InviteLink) => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("member");
  const create = useMutation({
    mutationFn: () => api<InviteLink & { id: number }>("POST", "/users", { email, name, role }),
    onSuccess: (invite) => onCreated(email, invite),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }
  return (
    <Modal title="Invite a team member" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>Email</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">Member — uses the gateway with their own keys</option>
            <option value="admin">Admin — also manages servers and the team</option>
          </select>
        </label>
        <ErrorText error={create.error} />
        <footer className="modal-foot">
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create invite link"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
