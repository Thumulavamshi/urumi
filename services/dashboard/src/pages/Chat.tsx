// Chat with the store's tools, as yourself. The gateway runs the LLM tool loop
// (POST /api/chat) and streams each tool call and result; every call lands in
// the audit log under your name with via=chat. The transcript lives in this
// tab (sessionStorage) and is sent with each message — the server keeps none.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, streamChat, type ChatConfig, type ChatEvent, type Me } from "../api.ts";
import { Markdown } from "../markdown.tsx";
import { Link } from "../router.tsx";
import { ErrorText } from "../ui.tsx";

interface ToolStep {
  id: string;
  name: string;
  args: unknown;
  result?: { ok: boolean; durationMs: number; preview: string };
}

type Turn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; steps: ToolStep[]; status?: string; error?: string; done?: { tokens: number; model: string } };

const SUGGESTIONS = [
  "What orders came in today?",
  "What were the most recent orders, and what's their total in EUR?",
  'Create a product "Urumi Mug" priced 14.99',
  "Add a follow-up note to the latest order: customer asked for gift wrap",
];

const storageKey = (me: Me) => `chat:${me.id}`;
function loadTurns(me: Me): Turn[] {
  try {
    return JSON.parse(sessionStorage.getItem(storageKey(me)) ?? "[]") as Turn[];
  } catch {
    return [];
  }
}

export function ChatPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ["chat-config"], queryFn: () => get<ChatConfig>("/chat/config"), staleTime: 60_000 });
  const [turns, setTurns] = useState<Turn[]>(() => loadTurns(me));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey(me), JSON.stringify(turns));
    } catch {
      // storage unavailable (private mode etc.): the chat still works in memory
    }
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns, me]);

  useEffect(() => () => abortRef.current?.abort(), []); // leaving the page stops the reply

  /** Apply one streamed event to the last (assistant) turn. */
  function apply(e: ChatEvent) {
    setTurns((prev) => {
      const next = [...prev];
      const last = next.at(-1);
      if (!last || last.role !== "assistant") return prev;
      const turn = { ...last, steps: [...last.steps], status: undefined as string | undefined };
      switch (e.type) {
        case "tool_call":
          turn.steps.push({ id: e.id, name: e.name, args: e.args });
          break;
        case "tool_result":
          turn.steps = turn.steps.map((s) => (s.id === e.id ? { ...s, result: { ok: e.ok, durationMs: e.durationMs, preview: e.preview } } : s));
          break;
        case "status":
          turn.status = e.message;
          break;
        case "message":
          turn.content = e.content;
          break;
        case "error":
          turn.error = e.message;
          break;
        case "done":
          turn.done = { tokens: e.tokens, model: e.model };
          break;
      }
      next[next.length - 1] = turn;
      return next;
    });
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    setError(null);
    setInput("");
    // History for the LLM: user messages and the assistant's final answers.
    const history = [...turns, { role: "user" as const, content }]
      .filter((t) => t.content)
      .map((t) => ({ role: t.role, content: t.content }));
    setTurns((prev) => [...prev, { role: "user", content }, { role: "assistant", content: "", steps: [] }]);
    setBusy(true);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      await streamChat(history, apply, abort.signal);
    } catch (err) {
      if (!abort.signal.aborted) {
        setError(err);
        setTurns((prev) => (prev.at(-1)?.role === "assistant" && !prev.at(-1)!.content ? prev.slice(0, -1) : prev));
      } else {
        apply({ type: "error", message: "Stopped." });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      void qc.invalidateQueries({ queryKey: ["audit"] });
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  }

  const enabled = config.data?.enabled;

  return (
    <div className="chat">
      <header className="page-head">
        <div>
          <h1>Chat</h1>
          <p className="muted">
            Ask about the store in plain language. The assistant uses the gateway's tools <strong>as you</strong>: every call is in the{" "}
            <Link to="/audit">audit log</Link> under {me.email}.
            {config.data?.model && <span className="small"> Model: {config.data.model}.</span>}
          </p>
        </div>
        {turns.length > 0 && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              setTurns([]);
              setError(null);
            }}
          >
            New chat
          </button>
        )}
      </header>

      {config.data && !enabled && (
        <p className="note">Chat isn't configured: the gateway has no LLM API key. An admin needs to create the platform-llm Secret.</p>
      )}

      <div className="chat-log">
        {turns.length === 0 && enabled && (
          <div className="suggestions">
            <p className="muted">Try:</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="btn suggestion" onClick={() => void send(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="bubble bubble-user">
              {t.content}
            </div>
          ) : (
            <div key={i} className="bubble bubble-assistant">
              {t.steps.map((s) => (
                <ToolChip key={s.id} step={s} />
              ))}
              {t.content && <Markdown text={t.content} />}
              {!t.content && !t.error && busy && i === turns.length - 1 && (
                <p className="muted thinking">{t.status ?? (t.steps.some((s) => !s.result) ? "Running tool…" : "Thinking…")}</p>
              )}
              {t.error && <p className="error">{t.error}</p>}
              {t.done && (
                <p className="muted small">
                  {t.steps.length} tool call{t.steps.length === 1 ? "" : "s"} · {t.done.tokens.toLocaleString()} tokens
                </p>
              )}
            </div>
          ),
        )}
        <div ref={bottomRef} />
      </div>

      <ErrorText error={error} />
      <form className="chat-input" onSubmit={submit}>
        <textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={enabled ? "Ask something… (Enter to send, Shift+Enter for a new line)" : "Chat is not configured"}
          disabled={!enabled}
          maxLength={8000}
          aria-label="Message"
        />
        {busy ? (
          <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button className="btn btn-primary" disabled={!enabled || !input.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}

function ToolChip({ step }: { step: ToolStep }) {
  const r = step.result;
  const state = !r ? "running" : r.ok ? "ok" : "failed";
  return (
    <details className={`tool-chip tool-${state}`}>
      <summary>
        <span className="tool-icon">{!r ? "…" : r.ok ? "✓" : "✕"}</span> called <code>{step.name}</code>
        {r && <span className="muted"> · {r.durationMs} ms</span>}
      </summary>
      <div className="tool-body">
        <div className="small muted">Arguments</div>
        <pre>{JSON.stringify(step.args, null, 2)}</pre>
        {r && (
          <>
            <div className="small muted">{r.ok ? "Result" : "Error"}</div>
            <pre>{r.preview}</pre>
          </>
        )}
      </div>
    </details>
  );
}
