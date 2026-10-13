#!/usr/bin/env bash
# Build our images and push them to the local k3d registry.
#   scripts/build-images.sh            # all images
#   scripts/build-images.sh wordpress  # just one
# Pods pull them as urumi-registry:5000/<name>:<tag> (see values-local.yaml).
set -euo pipefail
cd "$(dirname "$0")/.."

REGISTRY="${REGISTRY:-localhost:5000}"
TAG="${TAG:-dev}"

declare -A CONTEXTS=(
  [store-wordpress]=images/wordpress
  [woo-mcp]=services/woo-mcp
)

build() {
  local name="$1" ctx="${CONTEXTS[$1]}"
  echo "==> building ${REGISTRY}/${name}:${TAG} from ${ctx}"
  docker build -t "${REGISTRY}/${name}:${TAG}" "$ctx"
  docker push "${REGISTRY}/${name}:${TAG}"
}

if [ $# -eq 0 ]; then
  for name in "${!CONTEXTS[@]}"; do build "$name"; done
else
  for name in "$@"; do
    [ -n "${CONTEXTS[$name]:-}" ] || { echo "unknown image: $name (known: ${!CONTEXTS[*]})"; exit 1; }
    build "$name"
  done
fi
