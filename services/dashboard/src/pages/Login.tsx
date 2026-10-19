import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.ts";
import { ErrorText } from "../ui.tsx";

export function LoginPage() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => api("POST", "/auth/login", { email, password }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    login.mutate();
  }

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          MCP Gateway
        </div>
        <h1>Sign in</h1>
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <ErrorText error={login.error} />
        <button className="btn btn-primary" disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
        <p className="muted small">New team members sign up through the invite link an admin sends them.</p>
      </form>
    </div>
  );
}
