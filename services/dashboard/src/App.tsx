import { useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError, get, type Me } from "./api.ts";
import { Link, navigate, usePath } from "./router.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { InvitePage } from "./pages/Invite.tsx";
import { ServersPage } from "./pages/Servers.tsx";
import { KeysPage } from "./pages/Keys.tsx";
import { AuditPage } from "./pages/Audit.tsx";
import { TeamPage } from "./pages/Team.tsx";
import { ChatPage } from "./pages/Chat.tsx";

interface NavItem {
  to: string;
  label: string;
  adminOnly?: boolean;
  page: (me: Me) => React.ReactNode;
}

const NAV: NavItem[] = [
  { to: "/", label: "Servers", page: (me) => <ServersPage me={me} /> },
  { to: "/chat", label: "Chat", page: (me) => <ChatPage me={me} /> },
  { to: "/keys", label: "My API keys", page: () => <KeysPage /> },
  { to: "/audit", label: "Audit log", page: (me) => <AuditPage me={me} /> },
  { to: "/team", label: "Team", adminOnly: true, page: (me) => <TeamPage me={me} /> },
];

export function App() {
  const path = usePath();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => get<Me>("/auth/me"),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
    staleTime: 60_000,
  });

  // Invite links work whether or not someone is logged in on this browser.
  const invite = /^\/invite\/([^/]+)$/.exec(path);
  if (invite) return <InvitePage token={invite[1]!} />;

  if (me.isPending) return <div className="center muted">Loading…</div>;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) return <LoginPage />;
    return (
      <div className="center">
        <p className="error">Can't reach the gateway: {me.error.message}</p>
        <button className="btn" onClick={() => me.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const user = me.data;
  const items = NAV.filter((n) => !n.adminOnly || user.role === "admin");
  const current = items.find((n) => n.to === path);
  if (!current) {
    navigate("/", true);
    return null;
  }
  return <Shell me={user} items={items} current={current} />;
}

function Shell({ me, items, current }: { me: Me; items: NavItem[]; current: NavItem }) {
  // A full reload after logout guarantees no cached data from this user survives.
  const logout = useMutation({
    mutationFn: () => api("POST", "/auth/logout"),
    onSettled: () => window.location.assign("/"),
  });
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={24} height={24} />
          MCP Gateway
        </div>
        <nav>
          {items.map((n) => (
            <Link key={n.to} to={n.to} className={n === current ? "nav-link active" : "nav-link"}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="whoami">
          <div className="whoami-name">{me.name}</div>
          <div className="muted small">
            {me.email} · {me.role}
          </div>
          <button className="btn btn-small" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Log out
          </button>
        </div>
      </aside>
      <main className="content">{current.page(me)}</main>
    </div>
  );
}
