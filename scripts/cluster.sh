#!/bin/sh

set -euo pipefail

usage() {
  echo "Usage: $0 {create|setup|delete}" >&2
}

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

setup)
  ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
  SUBNET=$(docker network inspect k3d-local-cluster | jq -r '.[0].IPAM.Config[0].Subnet')
  if [ -z "$SUBNET" ] || [ "$SUBNET" = "null" ]; then
    echo "Failed to detect k3d network subnet. Is the cluster running?" >&2
    exit 1
  fi
  echo "Installing Helm-based addons (MetalLB, ingress, etc.)..."
  kubectl apply -k "$ROOT_DIR/helm-charts"

  echo "Waiting for MetalLB CRDs to be established..."
  TIMEOUT=120
  while ! kubectl get crd ipaddresspools.metallb.io >/dev/null 2>&1; do
    [ $TIMEOUT -le 0 ] && {
      echo "Timed out waiting for ipaddresspools.metallb.io" >&2
      exit 1
    }
    sleep 2
    TIMEOUT=$((TIMEOUT - 2))
  done
  TIMEOUT=120
  while ! kubectl get crd l2advertisements.metallb.io >/dev/null 2>&1; do
    [ $TIMEOUT -le 0 ] && {
      echo "Timed out waiting for l2advertisements.metallb.io" >&2
      exit 1
    }
    sleep 2
    TIMEOUT=$((TIMEOUT - 2))
  done

  kubectl -n metallb-system rollout status deploy/controller --timeout=120s ||
    kubectl -n metallb-system rollout status deploy/metallb-controller --timeout=120s || true

  echo "Applying core kustomization with IP pool range: $SUBNET"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  mkdir -p "$TMP_DIR"
  cp -R "$ROOT_DIR/core/." "$TMP_DIR/"
  export IP_POOL_RANGE="$SUBNET"
  for f in "$TMP_DIR"/*.yaml; do
    [ -f "$f" ] || continue
    [ "$(basename "$f")" = "kustomization.yaml" ] && continue
    envsubst <"$f" >"$f.tmp" && mv "$f.tmp" "$f"
  done
  kubectl apply -k "$TMP_DIR"
  echo "Setup complete."
  ;;

delete)
  echo "Deleting k3d cluster 'local-cluster'..."
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
