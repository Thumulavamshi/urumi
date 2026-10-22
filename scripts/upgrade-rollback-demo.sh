#!/usr/bin/env bash
# Upgrade / rollback demo for the platform release (local k3d cluster).
#
#   scripts/upgrade-rollback-demo.sh
#
# 1. Good upgrade: the current gateway image gets an immutable tag (the git
#    commit) and the release is upgraded to it.
# 2. Bad upgrade: an image tag that doesn't exist. `helm upgrade --wait` fails,
#    but the old pod keeps serving (rolling update with maxUnavailable: 0).
# 3. `helm rollback` to the good revision, then back to where we started.
#
# A probe hits the gateway's /healthz every 0.5s throughout and reports every
# failed request, so "no downtime" is measured, not claimed.
set -euo pipefail
cd "$(dirname "$0")/.."

NS=platform
RELEASE=platform
URL="${GATEWAY_URL:-http://app.127.0.0.1.nip.io}/healthz"
VALUES=(-f charts/platform/values-local.yaml)
kubectl config use-context k3d-urumi >/dev/null

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
running_image() {
  kubectl -n "$NS" get pods -l app.kubernetes.io/name=gateway \
    -o jsonpath='{range .items[*]}{.metadata.name}  {.spec.containers[0].image}  ready={.status.containerStatuses[0].ready}{"\n"}{end}'
}
revision() { helm -n "$NS" history "$RELEASE" -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).at(-1).revision))'; }

# Availability probe in the background.
probe_log=$(mktemp)
( while true; do
    code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$URL" || true)
    [ "$code" = 200 ] && echo ok >>"$probe_log" || echo "$(date +%T) HTTP $code" >>"$probe_log"
    sleep 0.5
  done ) &
probe_pid=$!
trap 'kill $probe_pid 2>/dev/null; rm -f "$probe_log"' EXIT

start_rev=$(revision)
step "Starting point: revision $start_rev"
running_image

step "1. Good upgrade: gateway image tagged with the commit"
tag="git-$(git rev-parse --short HEAD)"
docker tag localhost:5000/gateway:dev "localhost:5000/gateway:$tag"
docker push -q "localhost:5000/gateway:$tag" >/dev/null
helm upgrade "$RELEASE" charts/platform -n "$NS" "${VALUES[@]}" \
  --set gateway.image.tag="$tag" --set gateway.image.pullPolicy=IfNotPresent \
  --wait --timeout 3m --description "gateway $tag" >/dev/null
good_rev=$(revision)
echo "revision $good_rev deployed"
running_image

step "2. Bad upgrade: an image tag that doesn't exist (expected to fail)"
if helm upgrade "$RELEASE" charts/platform -n "$NS" "${VALUES[@]}" \
  --set gateway.image.tag=does-not-exist --set gateway.image.pullPolicy=IfNotPresent \
  --wait --timeout 60s --description "broken image" >/dev/null 2>&1; then
  echo "unexpected: the broken upgrade succeeded"; exit 1
fi
echo "helm upgrade failed, as expected. Pods right now:"
running_image
echo "(the old pod is still Ready and serving; the new one can't pull its image)"

step "3. Roll back to the good revision $good_rev"
helm rollback "$RELEASE" "$good_rev" -n "$NS" --wait --timeout 3m >/dev/null
running_image

step "Back to the starting configuration (revision $start_rev)"
helm rollback "$RELEASE" "$start_rev" -n "$NS" --wait --timeout 3m >/dev/null
running_image

step "Release history"
helm -n "$NS" history "$RELEASE" --max 6

step "Availability during all of the above"
total=$(wc -l <"$probe_log")
failed=$(grep -vc '^ok$' "$probe_log" || true)
echo "$total probes of $URL, $failed failed"
grep -v '^ok$' "$probe_log" || true
