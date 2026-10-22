// SSRF guard for upstream server URLs.
//
// Admins type upstream URLs into the dashboard, and the gateway then sends
// requests there carrying stored credentials — so a URL must not be able to
// point the gateway at things only it can reach: the cloud metadata service,
// its own loopback, the Kubernetes API, Postgres, other teams' services.
//
// Rules, checked against every address the host name resolves to:
//   - always blocked: loopback, link-local (incl. 169.254.169.254 metadata),
//     unspecified, multicast, reserved — even for allowlisted hosts;
//   - private ranges (RFC 1918, CGNAT, IPv6 ULA — where cluster pods and
//     Services live): blocked unless the host name is on the allowlist, e.g.
//     "*.store.svc.cluster.local". Our own upstreams live in the cluster, so
//     the allowlist names exactly the namespaces that hold MCP servers;
//   - public addresses: allowed.
//
// The check runs inside the HTTP client's DNS lookup (`connect.lookup`), i.e. on
// the address actually connected to, so a host that resolves to a public IP at
// save time and a private one later (DNS rebinding) is still caught. Redirects
// are refused by the transport (redirect: "error"). The NetworkPolicy on the
// gateway's egress is the second, independent layer.
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export class SsrfError extends Error {
  override name = "SsrfError";
}

const ALWAYS_BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network", 0.0.0.0
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["192.0.0.0", 24], // IETF protocol assignments
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) ALWAYS_BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["fd00:ec2::254", 128], // AWS metadata over IPv6
] as const) ALWAYS_BLOCKED.addSubnet(net, prefix, "ipv6");

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10], // CGNAT (some clusters use it for pods)
] as const) PRIVATE.addSubnet(net, prefix, "ipv4");
PRIVATE.addSubnet("fc00::", 7, "ipv6"); // unique local

/** "::ffff:10.0.0.1" -> ["10.0.0.1", "ipv4"], so mapped addresses can't sneak past the IPv4 rules. */
function normalize(address: string): [string, "ipv4" | "ipv6"] {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return [mapped[1]!, "ipv4"];
  return [address, isIP(address) === 6 ? "ipv6" : "ipv4"];
}

export class SsrfGuard {
  #allowed: string[];
  readonly #agent: Agent;

  /** @param allowedHosts host names or "*.suffix" patterns that may resolve to private addresses */
  constructor(allowedHosts: string[]) {
    this.#allowed = allowedHosts.map((h) => h.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
    this.#agent = new Agent({ connect: { lookup: this.#lookup } });
  }

  get allowedHosts(): readonly string[] {
    return this.#allowed;
  }

  hostAllowed(host: string): boolean {
    const h = host.toLowerCase().replace(/\.$/, "");
    return this.#allowed.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p));
  }

  /** Why connecting to `address` (resolved from `host`) is refused, or null if it's fine. */
  reason(host: string, address: string): string | null {
    const [ip, family] = normalize(address);
    const what = isIP(host) ? ip : `${host} (${ip})`;
    if (ALWAYS_BLOCKED.check(ip, family)) return `${what} is a loopback/link-local/reserved address`;
    if (PRIVATE.check(ip, family) && !this.hostAllowed(host)) {
      return `${what} is a private address and ${host} is not on the gateway's allowlist of internal hosts`;
    }
    return null;
  }

  /** Friendly up-front check when an admin saves or tests a URL. Throws SsrfError. */
  async check(url: string): Promise<void> {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    let addresses: LookupAddress[];
    try {
      addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await dnsLookupAll(host);
    } catch {
      return; // unresolvable: not an SSRF problem; the connection attempt will report "host not found"
    }
    for (const a of addresses) {
      const why = this.reason(host, a.address);
      if (why) throw new SsrfError(`URL blocked: ${why}`);
    }
  }

  /** fetch for the MCP client transport: every connection goes through the guarded lookup. */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    // IP literals never reach the DNS lookup, so check them here.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) {
      const why = this.reason(host, host);
      if (why) throw new SsrfError(`URL blocked: ${why}`);
    }
    return (await undiciFetch(url, { ...(init as object), dispatcher: this.#agent })) as unknown as Response;
  };

  // net.connect's `lookup` hook: resolve, refuse if any address is off-limits.
  #lookup = (
    hostname: string,
    options: LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "");
      for (const a of addresses) {
        const why = this.reason(hostname, a.address);
        if (why) return callback(Object.assign(new SsrfError(`URL blocked: ${why}`), { code: "ESSRF" }), "");
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };

  close(): Promise<void> {
    return this.#agent.close();
  }
}

function dnsLookupAll(host: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) =>
    dnsLookup(host, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses))),
  );
}
