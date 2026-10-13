#!/usr/bin/env bash
# Create (or reuse) the local k3d cluster defined in infra/k3d-local.yaml.
set -euo pipefail
cd "$(dirname "$0")/.."

if k3d cluster list urumi >/dev/null 2>&1; then
  echo "cluster 'urumi' already exists; starting it"
  k3d cluster start urumi
else
  k3d cluster create --config infra/k3d-local.yaml
fi

kubectl config use-context k3d-urumi
kubectl get nodes -o wide
