// One JSON object per line on stdout: what `kubectl logs` and log shippers expect.
export function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // fetch() hides the useful part (ECONNREFUSED, ENOTFOUND…) in `cause`.
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return `${err.message} (${cause.code})`;
    return err.message;
  }
  return String(err);
}
