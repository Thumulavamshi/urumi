import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, get } from "../api.ts";
import { navigate } from "../router.tsx";
import { ErrorText } from "../ui.tsx";

// /invite/<token>: set a password and get logged in. Also used for password resets.
export function InvitePage({ token }: { token: string }) {
  const qc = useQueryClient();
  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => get<{ email: string; name: string }>(`/invites/${encodeURIComponent(token)}`),
    retry: false,
  });
  const [name, setName] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const accept = useMutation({
    mutationFn: () => {
      if (password !== confirm) throw new Error("passwords don't match");
      return api("POST", `/invites/${encodeURIComponent(token)}/accept`, { password, name: name ?? invite.data?.name });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate("/keys", true);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    accept.mutate();
  }

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          MCP Gateway
        </div>
        {invite.isPending && <p className="muted">Checking invite…</p>}
        {invite.error && (
          <>
            <h1>Invite not valid</h1>
            <p className="muted">This link was already used, has expired, or was replaced by a newer one. Ask an admin for a new invite.</p>
            <a className="btn" href="/">
              Go to sign in
            </a>
          </>
        )}
        {invite.data && (
          <form onSubmit={submit} className="stack">
            <h1>Join the team</h1>
            <p className="muted">
              Setting up <strong>{invite.data.email}</strong>
            </p>
            <label className="field">
              <span>Name</span>
              <input required value={name ?? invite.data.name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>Password (at least 10 characters)</span>
              <input type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="field">
              <span>Confirm password</span>
              <input type="password" autoComplete="new-password" minLength={10} required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            <ErrorText error={accept.error} />
            <button className="btn btn-primary" disabled={accept.isPending}>
              {accept.isPending ? "Setting up…" : "Set password and sign in"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
