#!/usr/bin/env bash
# Install/upgrade the Helm releases on the local k3d cluster.
#   scripts/deploy-local.sh          # everything built so far
#   scripts/deploy-local.sh store    # one release
set -euo pipefail
cd "$(dirname "$0")/.."

kubectl config use-context k3d-urumi >/dev/null

deploy_store() {
  # --wait: resources ready before the post-install setup Job runs, and Helm
  # waits for that Job too. First install pulls images + installs WP (~2-4 min).
  helm upgrade --install store charts/store \
    --namespace store --create-namespace \
    -f charts/store/values-local.yaml \
    --wait --timeout 10m
}

targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(store)
for t in "${targets[@]}"; do
  echo "==> deploying $t"
  "deploy_$t"
done
