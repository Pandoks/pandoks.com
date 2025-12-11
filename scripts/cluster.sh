#!/bin/sh
set -euo pipefail

BOLD='\e[1m'
NORMAL='\e[0m'
RED='\e[31m'

usage() {
  printf "%bUsage:%b %s <command> [options]\n\n" "$BOLD" "$NORMAL" "$0" >&2
  printf "%bCommands:%b\n" "$BOLD" "$NORMAL" >&2
  printf "  k3d-up   : Create local k3d cluster (only for k3d)\n" >&2
  printf "  k3d-down : Delete local k3d cluster (only for k3d)\n" >&2
  printf "  setup    : Install addons and apply /k3s manifests on current kubecontext\n" >&2
  printf "  secrets  : Render k3s manifests by replacing \${sst.<VAR>} with SST secrets\n\n" >&2
  printf "%bOptions:%b\n" "$BOLD" "$NORMAL" >&2
  printf "  --kubeconfig <PATH>  Use the specified kubeconfig for kubectl operations\n" >&2
  printf "  --k3d                Force k3d mode (auto IP pool from k3d docker network)\n" >&2
  printf "  --ip-pool <RANGE>    Explicit MetalLB pool (e.g., 10.0.1.100-10.0.1.200 or 10.0.1.0/24)\n" >&2
  printf "  --network <NAME>     Attach k3d loadbalancer to an existing docker network\n" >&2
  printf "  --dry-run            Render and print YAML without applying to the cluster\n" >&2
  exit 1
}

# Require subcommand first, then parse flags/options in any order
[ $# -ge 1 ] || usage
CMD="$1"
shift
case "$CMD" in
k3d-up | setup | k3d-down | secrets) ;;
*) 
  printf "%bError:%b Unknown command '%s'\n" "$RED" "$NORMAL" "$CMD" >&2
  usage 
  exit 1
  ;;
esac

KUBECONFIG_FLAG=""
FORCE_K3D="false"
EXPLICIT_IP_POOL=""
NETWORK_NAME=""
DRY_RUN="false"
while [ $# -gt 0 ]; do
  case "$1" in
  --kubeconfig)
    [ $# -ge 2 ] || {
      echo "--kubeconfig requires a path" >&2
      exit 1
    }
    KUBECONFIG_FLAG="$2"
    shift 2
    continue
    ;;
  --k3d)
    FORCE_K3D="true"
    shift
    continue
    ;;
  --ip-pool)
    [ $# -ge 2 ] || {
      echo "--ip-pool requires a range (e.g., 10.0.1.100-10.0.1.200 or 10.0.1.0/24)" >&2
      exit 1
    }
    EXPLICIT_IP_POOL="$2"
    shift 2
    continue
    ;;
  --network)
    [ $# -ge 2 ] || {
      echo "--network requires a network name" >&2
      exit 1
    }
    NETWORK_NAME="$2"
    shift 2
    continue
    ;;
  --dry-run)
    DRY_RUN="true"
    shift
    continue
    ;;
  --*)
    echo "Unknown option: $1" >&2
    usage
    ;;
  *)
    echo "Unexpected argument: $1" >&2
    usage
    ;;
  esac
done

# Export kubeconfig if provided
if [ -n "$KUBECONFIG_FLAG" ]; then
  if [ ! -f "$KUBECONFIG_FLAG" ]; then
    echo "kubeconfig not found: $KUBECONFIG_FLAG" >&2
    exit 1
  fi
  KUBECONFIG=$(cd "$(dirname "$KUBECONFIG_FLAG")" && pwd)/"$(basename "$KUBECONFIG_FLAG")"
  export KUBECONFIG
  echo "Using kubeconfig: $KUBECONFIG"
fi

case "$CMD" in
k3d-up)
  if k3d cluster list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "local-cluster"; then
    echo "k3d cluster 'local-cluster' already exists. Skipping create."
    exit 0
  fi
  echo "Creating k3d cluster 'local-cluster'..."
  NET_ARGS=""
  if [ -n "$NETWORK_NAME" ]; then
    # ensure network exists
    if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
      echo "Docker network not found: $NETWORK_NAME" >&2
      exit 1
    fi
    NET_ARGS="--network $NETWORK_NAME"
    echo "Attaching loadbalancer to docker network: $NETWORK_NAME"
  fi
  k3d cluster create local-cluster \
    --servers 3 \
    --agents 3 \
    --registry-create local-registry:12345 \
    --api-port 6444 \
    --k3s-arg "--disable=traefik@server:*" \
    --k3s-arg "--disable=servicelb@server:*" \
    -p "8080:30080@loadbalancer" \
    ${NET_ARGS}
  echo "Cluster created."
  ;;

setup)
  SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  K3S_DIR="$REPO_ROOT/k3s"
  # Resolve IP pool range according to flags/env
  if [ "$FORCE_K3D" = "true" ]; then
    NET_TO_USE="${NETWORK_NAME:-k3d-local-cluster}"
    if ! docker network inspect "$NET_TO_USE" >/dev/null 2>&1; then
      echo "--k3d specified but docker network not found: $NET_TO_USE" >&2
      echo "Provide an existing network with --network NAME or create the k3d cluster first." >&2
      exit 1
    fi
    SUBNET=$(docker network inspect "$NET_TO_USE" | jq -r '.[0].IPAM.Config[0].Subnet')
    if [ -z "$SUBNET" ] || [ "$SUBNET" = "null" ]; then
      echo "Failed to detect subnet from network '$NET_TO_USE'. Is the cluster/network running?" >&2
      exit 1
    fi
    IP_POOL_RANGE="$SUBNET"
    echo "k3d mode: using network '$NET_TO_USE' with IP pool $IP_POOL_RANGE"
  elif [ -n "$EXPLICIT_IP_POOL" ]; then
    IP_POOL_RANGE="$EXPLICIT_IP_POOL"
    echo "Using IP pool from --ip-pool: $IP_POOL_RANGE"
  elif [ -n "${IP_POOL_RANGE:-}" ]; then
    echo "Using IP pool from IP_POOL_RANGE env: $IP_POOL_RANGE"
  else
    echo "Error: Provide an IP pool via --ip-pool or IP_POOL_RANGE, or use --k3d to auto-detect." >&2
    echo "Example: --ip-pool 10.0.1.100-10.0.1.200" >&2
    exit 1
  fi

  # Validate IP pool (supports start-end or CIDR)
  validate_ip_segment() {
    echo "$1" | awk 'BEGIN{ok=1} {
      if ($0 !~ /^[0-9]+$/) ok=0; else { n=$0+0; if (n<0 || n>255) ok=0 }
    } END{ exit ok?0:1 }'
  }

  is_ipv4() {
    IFS='.' read -r a b c d <<EOF
$1
EOF
    [ -n "$a" ] && [ -n "$b" ] && [ -n "$c" ] && [ -n "$d" ] || return 1
    validate_ip_segment "$a" && validate_ip_segment "$b" && validate_ip_segment "$c" && validate_ip_segment "$d"
  }

  validate_range() {
    RANGE="$1"
    case "$RANGE" in
    */*)
      # CIDR form
      base="${RANGE%/*}"
      mask="${RANGE##*/}"
      is_ipv4 "$base" || return 1
      echo "$mask" | awk 'BEGIN{ok=1} { if ($0 !~ /^[0-9]+$/) ok=0; else { n=$0+0; if (n<0 || n>32) ok=0 } } END{ exit ok?0:1 }' || return 1
      return 0
      ;;
    *-*)
      # start-end form
      start="${RANGE%-*}"
      end="${RANGE#*-}"
      is_ipv4 "$start" || return 1
      is_ipv4 "$end" || return 1
      # ensure start <= end lexicographically numeric
      awk -v s="$start" -v e="$end" 'BEGIN{
          split(s,sa,"."); split(e,ea,".");
          for(i=1;i<=4;i++){ if (sa[i]+0<ea[i]+0) { exit 0 } else if (sa[i]+0>ea[i]+0) { exit 1 } }
          exit 0
        }' || return 1
      return 0
      ;;
    *)
      return 1
      ;;
    esac
  }

  if ! validate_range "$IP_POOL_RANGE"; then
    echo "Invalid IP pool range: $IP_POOL_RANGE" >&2
    echo "Acceptable formats: A.B.C.D/NN or A.B.C.D-E.F.G.H" >&2
    exit 1
  fi
  echo "Installing Helm-based addons (MetalLB, ingress, etc.)..."
  kubectl apply -k "$K3S_DIR/helm-charts"

  echo "Waiting for cert-manager CRDs to be established..."
  for crd in certificates.cert-manager.io issuers.cert-manager.io clusterissuers.cert-manager.io; do
    TIMEOUT=180
    while ! kubectl get crd "$crd" >/dev/null 2>&1; do
      [ $TIMEOUT -le 0 ] && { echo "Timed out waiting for $crd" >&2; exit 1; }
      sleep 2
      TIMEOUT=$((TIMEOUT - 2))
    done
  done
  echo "Waiting for cert-manager deployments to roll out..."
  kubectl -n cert-manager rollout status deploy/cert-manager --timeout=300s || true
  kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=300s || true
  kubectl -n cert-manager rollout status deploy/cert-manager-cainjector --timeout=300s || true

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

  kubectl -n metallb-system rollout status deploy/metallb-controller --timeout=300s

  echo "Applying core kustomization with IP pool range: ${IP_POOL_RANGE}"
  export IP_POOL_RANGE="${IP_POOL_RANGE}"
  kubectl kustomize "$K3S_DIR/core" --load-restrictor LoadRestrictionsNone | envsubst | kubectl apply -f -

  echo "Setup complete."
  ;;

k3d-down)
  echo "Deleting k3d cluster 'local-cluster'..."
  if k3d cluster list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "local-cluster"; then
    k3d cluster delete local-cluster
    echo "Cluster deleted."
  else
    echo "k3d cluster 'local-cluster' not found. Nothing to delete."
  fi
  ;;

secrets)
  SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  K3S_DIR="$REPO_ROOT/k3s"
  SECRETS_YAML="$K3S_DIR/apps/secrets.yaml"
  [ -f "$SECRETS_YAML" ] || { echo "Missing $SECRETS_YAML" >&2; exit 1; }

  echo "Fetching SST secrets..." >&2
  if ! SECRETS_JSON=$(cd "$REPO_ROOT" && pnpm sst shell node scripts/secrets.js 2>/dev/null); then
    echo "Error: Failed to fetch SST secrets. Make sure you're authenticated with SST." >&2
    echo "Try running: pnpm sst shell" >&2
    exit 1
  fi

  # Create temp file to work with
  TMP_FILE=$(mktemp)
  trap 'rm -f "$TMP_FILE"' EXIT
  cp "$SECRETS_YAML" "$TMP_FILE"

  # Extract all unique ${sst.Key} patterns from the secrets.yaml file
  SST_KEYS=$(grep -o '\${sst\.[^}]*}' "$SECRETS_YAML" | sed 's/\${sst\.//g' | sed 's/}//g' | sort -u)
  
  if [ -z "$SST_KEYS" ]; then
    echo "No \${sst.Key} patterns found in $SECRETS_YAML" >&2
    exit 1
  fi
  
  echo "Found SST keys: $(echo "$SST_KEYS" | tr '\n' ' ')" >&2

  # Replace placeholders with proper indentation
  for key in $SST_KEYS; do
    VALUE=$(printf '%s' "$SECRETS_JSON" | jq -r --arg key "$key" '.[$key].value // empty')
    
    if [ -z "$VALUE" ]; then
      echo "Warning: No value found for key: $key" >&2
      sed -i.bak "s/\${sst\.$key}/MISSING_KEY_$key/g" "$TMP_FILE" && rm -f "$TMP_FILE.bak"
    else
      # Check if the placeholder is on its own line (for multi-line values like certificates)
      if grep -q "^[[:space:]]*\${sst\.$key}[[:space:]]*$" "$TMP_FILE"; then
        # Create a temporary file with the value, adding 4-space indentation to each line
        VALUE_TEMP=$(mktemp)
        printf '%s\n' "$VALUE" | sed 's/^/    /' > "$VALUE_TEMP"
        
        # Replace the placeholder line with the indented content 
        sed -i.bak "/^[[:space:]]*\${sst\.$key}[[:space:]]*$/{
          r $VALUE_TEMP
          d
        }" "$TMP_FILE" && rm -f "$TMP_FILE.bak"
        
        rm -f "$VALUE_TEMP"
      else
        # For inline placeholders (like in JSON), do safe string replacement (escape &, | and \ in value)
        SAFE_VALUE=$(printf '%s' "$VALUE" | sed -e 's/[\\&|]/\\&/g')
        sed -i.bak "s|\${sst\.$key}|$SAFE_VALUE|g" "$TMP_FILE" && rm -f "$TMP_FILE.bak"
      fi
    fi
  done

  if [ "$DRY_RUN" = "true" ]; then
    cat "$TMP_FILE"
    exit 0
  else
    kubectl apply -f "$TMP_FILE"
  fi
  ;;

 
*)
  usage
  exit 1
  ;;
 esac

