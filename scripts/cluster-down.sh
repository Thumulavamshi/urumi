#!/usr/bin/env bash
# Delete the local cluster and its registry (all PVC data is lost).
set -euo pipefail
k3d cluster delete urumi
