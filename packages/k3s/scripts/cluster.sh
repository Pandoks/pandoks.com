#!/bin/sh

set -euo pipefail

usage() {
  echo "Usage: $0 {create|delete}" >&2
}

# Require exactly one subcommand
if [ $# -ne 1 ]; then
  usage
  exit 1
fi

CMD="$1"

case "$CMD" in
create)
  if k3d cluster list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "local-cluster"; then
    echo "k3d cluster 'local-cluster' already exists. Skipping create."
    exit 0
  fi
  echo "Creating k3d cluster 'local-cluster'..."
  k3d cluster create local-cluster \
    --agents 3 \
    --registry-create local-registry:12345 \
    --api-port 6443 \
    --k3s-arg "--disable=traefik@server:*" \
    --k3s-arg "--disable=servicelb@server:*" \
    -p "3000:30001@loadbalancer"
  echo "Cluster created."
  ;;
delete)
  echo "Deleting k3d cluster 'local-cluster'..."
  # If cluster doesn't exist, k3d returns non-zero; handle gracefully
  if k3d cluster list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "local-cluster"; then
    k3d cluster delete local-cluster
    echo "Cluster deleted."
  else
    echo "k3d cluster 'local-cluster' not found. Nothing to delete."
  fi
  ;;
*)
  usage
  exit 1
  ;;
esac
