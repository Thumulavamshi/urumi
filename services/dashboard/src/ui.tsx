// Small shared building blocks. Plain CSS (styles.css), no component library.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Outcome, ServerStatus } from "./api.ts";

export function Badge({ tone, children, title }: { tone: "ok" | "bad" | "warn" | "muted" | "info"; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

const STATUS: Record<ServerStatus, { tone: "ok" | "bad" | "muted" | "warn"; label: string }> = {
  connected: { tone: "ok", label: "Connected" },
  unreachable: { tone: "bad", label: "Unreachable" },
  disabled: { tone: "muted", label: "Disabled" },
  connecting: { tone: "warn", label: "Connecting" },
};
export function StatusBadge({ status }: { status: ServerStatus }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const OUTCOME: Record<Outcome, "ok" | "bad" | "warn" | "muted"> = {
  success: "ok",
  error: "bad",
  timeout: "warn",
  denied: "muted",
  unreachable: "bad",
};
export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  return <Badge tone={OUTCOME[outcome]}>{outcome}</Badge>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="error" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} onCancel={onClose}>
      <header className="modal-head">
        <h2>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API needs a secure context (https/localhost); fall back.
      const area = document.createElement("textarea");
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button type="button" className="btn btn-small" onClick={copy}>
      {copied ? "Copied" : label}
    </button>
  );
}

/** A secret / snippet shown in a monospace box with a copy button. */
export function CodeBox({ value }: { value: string }) {
  return (
    <div className="codebox">
      <code>{value}</code>
      <CopyButton text={value} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export function ago(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
