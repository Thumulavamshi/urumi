// Audits what's actually running (not the templates) against the hardening rules:
//
//   node scripts/audit-workloads.mjs                 # namespaces store, tools, platform
//   NAMESPACES=store,platform node scripts/audit-workloads.mjs
//
// Per container: requests + limits (cpu, memory); readiness + liveness probes
// (not for Jobs); non-root; no privilege escalation; all capabilities dropped;
// seccomp RuntimeDefault; pinned image tag; read-only root FS (listed when not,
// since some images legitimately need a writable one).
// Per pod: no service-account token. Per namespace: a default-deny
// NetworkPolicy, no NodePort/LoadBalancer Services, and Ingresses that only
// point at the public front doors (never at an MCP server or a database).
// Exits 1 if any hard rule fails.
import { execFileSync } from "node:child_process";

const NAMESPACES = (process.env.NAMESPACES ?? "store,tools,platform").split(",");
// Services an Ingress may route to; everything else (MCP servers, databases) must stay internal.
const PUBLIC_SERVICES = new Set((process.env.PUBLIC_SERVICES ?? "store-wordpress,platform-gateway,platform-dashboard").split(","));

function kubectl(...args) {
  try {
    return JSON.parse(execFileSync("kubectl", [...args, "-o", "json"], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (err) {
    const reason = String(err.stderr ?? err.message).trim().split("\n").at(-1);
    console.error(`kubectl ${args.join(" ")} failed: ${reason}`);
    process.exit(2);
  }
}

let failures = 0;
const notes = [];
const fail = (where, what) => {
  failures++;
  console.log(`FAIL  ${where}: ${what}`);
};

for (const ns of NAMESPACES) {
  console.log(`\n== namespace ${ns}`);
  const workloads = kubectl("-n", ns, "get", "deployments,statefulsets,daemonsets,jobs").items;
  for (const w of workloads) {
    const isJob = w.kind === "Job";
    const pod = w.spec.template.spec;
    const where = `${w.kind.toLowerCase()}/${w.metadata.name}`;
    const before = failures;

    if (pod.automountServiceAccountToken !== false) fail(where, "service-account token is mounted (automountServiceAccountToken not false)");
    if (pod.hostNetwork || pod.hostPID || pod.hostIPC) fail(where, "uses host namespaces");

    for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
      const at = `${where} [${c.name}]`;
      const sc = { ...pod.securityContext, ...c.securityContext };
      const r = c.resources ?? {};
      for (const kind of ["requests", "limits"]) {
        for (const res of ["cpu", "memory"]) if (!r[kind]?.[res]) fail(at, `no ${kind}.${res}`);
      }
      if (!isJob) {
        if (!c.readinessProbe) fail(at, "no readinessProbe");
        if (!c.livenessProbe) fail(at, "no livenessProbe");
      }
      if (sc.runAsNonRoot !== true) fail(at, "runAsNonRoot is not true");
      if (sc.runAsUser === 0) fail(at, "runs as uid 0");
      if (sc.privileged) fail(at, "privileged");
      if (sc.allowPrivilegeEscalation !== false) fail(at, "allowPrivilegeEscalation is not false");
      const dropped = (c.securityContext?.capabilities?.drop ?? []).map((x) => x.toUpperCase());
      if (!dropped.includes("ALL")) fail(at, "capabilities not dropped (drop: [ALL])");
      if (c.securityContext?.capabilities?.add?.length) fail(at, `adds capabilities ${c.securityContext.capabilities.add}`);
      if (sc.seccompProfile?.type !== "RuntimeDefault") fail(at, "seccompProfile is not RuntimeDefault");
      const tag = c.image.includes("@") ? "digest" : (c.image.split("/").pop().split(":")[1] ?? "latest");
      if (tag === "latest") fail(at, `image not pinned: ${c.image}`);
      if (sc.readOnlyRootFilesystem !== true) notes.push(`${at}: writable root filesystem`);
    }
    if (failures === before) console.log(`ok    ${where}`);
  }

  const policies = kubectl("-n", ns, "get", "networkpolicies").items;
  const defaultDeny = policies.find(
    (p) =>
      Object.keys(p.spec.podSelector ?? {}).length === 0 &&
      ["Ingress", "Egress"].every((t) => p.spec.policyTypes?.includes(t)) &&
      !p.spec.ingress?.length &&
      !p.spec.egress?.length,
  );
  if (defaultDeny) console.log(`ok    default-deny NetworkPolicy (${defaultDeny.metadata.name})`);
  else fail(ns, "no default-deny NetworkPolicy (podSelector {}, Ingress+Egress, no rules)");

  for (const s of kubectl("-n", ns, "get", "services").items) {
    if (s.spec.type === "NodePort" || s.spec.type === "LoadBalancer") fail(`service/${s.metadata.name}`, `type ${s.spec.type} exposes it outside the cluster`);
  }
  for (const ing of kubectl("-n", ns, "get", "ingresses").items) {
    const backends = (ing.spec.rules ?? []).flatMap((rule) => (rule.http?.paths ?? []).map((p) => p.backend.service?.name));
    for (const b of backends) {
      if (!PUBLIC_SERVICES.has(b)) fail(`ingress/${ing.metadata.name}`, `routes to ${b}, which is not a public front door`);
    }
    console.log(`ok    ingress/${ing.metadata.name} -> ${[...new Set(backends)].join(", ")}`);
  }
}

if (notes.length) console.log(`\nwritable root filesystems (allowed, review):\n  ${notes.join("\n  ")}`);
console.log(failures ? `\n${failures} check(s) failed` : "\nall hard checks passed");
process.exit(failures ? 1 : 0);
