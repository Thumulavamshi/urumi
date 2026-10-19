// A deliberately tiny client-side router: a handful of flat routes don't need
// a library. nginx serves index.html for every unknown path, so deep links and
// reloads work.
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

const listeners = new Set<() => void>();
window.addEventListener("popstate", () => listeners.forEach((l) => l()));

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(to: string, replace = false): void {
  if (to === window.location.pathname) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", to);
  listeners.forEach((l) => l());
}

export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  function handle(e: MouseEvent<HTMLAnchorElement>) {
    onClick?.(e);
    // Let the browser handle new-tab / modified clicks.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  }
  return <a href={to} onClick={handle} {...rest} />;
}
