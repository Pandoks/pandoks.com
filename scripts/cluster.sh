#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
readonly SCRIPT_DIR

. "${SCRIPT_DIR}/lib/font.sh"
. "${SCRIPT_DIR}/lib/ip.sh"

usage() {
  printf "%bUsage:%b %s <command> [options]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  k3d-up   : Create local k3d cluster (only for k3d)\n" >&2
  printf "  k3d-down : Delete local k3d cluster (only for k3d)\n" >&2
  printf "  setup    : Install addons and apply /k3s manifests on current kubecontext\n" >&2
  printf "  secrets  : Render k3s manifests by replacing \${sst.<VAR>} with SST secrets\n\n" >&2
  printf "%bOptions:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  --kubeconfig <PATH>  Use the specified kubeconfig for kubectl operations\n" >&2
  printf "  --k3d                Force k3d mode (auto IP pool from k3d docker network)\n" >&2
  printf "  --ip-pool <RANGE>    Explicit MetalLB pool (e.g., 10.0.1.100-10.0.1.200 or 10.0.1.0/24)\n" >&2
  printf "  --network <NAME>     Attach k3d loadbalancer to an existing docker network\n" >&2
  printf "  --dry-run            Render and print YAML without applying to the cluster\n" >&2
  exit 1
}

k3d_up() {
  k3d_up_network_name="$1"

  if k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    echo "k3d cluster 'local-cluster' already exists. Skipping creation."
    return 0
  fi

  echo "Creating k3d cluster 'local-cluster'..."
  if [ -n "${k3d_up_network_name}" ]; then
    if ! docker network inspect "${k3d_up_network_name}" > /dev/null 2>&1; then
      printf "%bError:%b docker network not found: %s\n" "${RED}" "${NORMAL}" "${k3d_up_network_name}" >&2
      return 1
    fi
    k3d_up_network_args="--network ${k3d_up_network_name}"
    echo "Attaching loadbalancer to docker network: ${k3d_up_network_name}"
  fi

  k3d cluster create local-cluster \
    --servers 3 \
    --agents 3 \
    --registry-create local-registry:12345 \
    --api-port 6444 \
    --k3s-arg "--disable=traefik@server:*" \
    --k3s-arg "--disable=servicelb@server:*" \
    -p "8080:30080@loadbalancer" \
    "${k3d_up_network_args}"
  printf "%b✓ k3d cluster created%b\n" "${GREEN}" "${NORMAL}"
}

k3d_down() {
  if ! k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    echo "k3d cluster 'local-cluster' not found. Nothing to delete."
    return 0
  fi

  echo "Deleting k3d cluster 'local-cluster'..."
  k3d cluster delete local-cluster
  printf "%b✓ k3d cluster deleted%b\n" "${GREEN}" "${NORMAL}"
}

main() {
  [ $# -ge 1 ] || usage
  cmd="$1"
  shift

  case "${cmd}" in
    k3d-up | setup | k3d-down | secrets) ;;
    *)
      printf "%bError:%b Unknown command '%s'\n" "${RED}" "${NORMAL}" "${cmd}" >&2
      usage
      ;;
  esac

  explicit_ip_pool=""
  network_name=""
  dry_run="false"

  while [ $# -gt 0 ]; do
    case "$1" in
      --kubeconfig)
        if [ $# -lt 2 ]; then
          printf "%bError:%b Missing value for --kubeconfig\n" "${RED}" "${NORMAL}" >&2
          exit 1
        fi
        kubeconfig_file="$2"
        if [ ! -f "${kubeconfig_file}" ]; then
          printf "%bError:%b kubeconfig not found: %s\n" \
            "${RED}" "${NORMAL}" "${kubeconfig_file}" >&2
          exit 1
        fi
        absolute_kubeconfig_dir="$(cd "$(dirname "${kubeconfig_file}")" && pwd)"
        base_kubeconfig_name="$(basename "${kubeconfig_file}")"
        export KUBECONFIG="${absolute_kubeconfig_dir}/${base_kubeconfig_name}"
        printf "%bUsing kubeconfig:%b %s\n" "${BOLD}" "${NORMAL}" "${KUBECONFIG}" >&2
        shift 2
        ;;
      --k3d)
        k3d_flag="true"
        shift
        ;;
      --ip-pool)
        if [ $# -lt 2 ]; then
          printf "%bError:%b --ip-pool requires a range (e.g., 10.0.1.100-10.0.1.200 or 10.0.1.0/24)\n" \
            "${RED}" "${NORMAL}" >&2
          exit 1
        fi
        explicit_ip_pool="$2"
        if ! validate_ip_pool_range "${explicit_ip_pool}"; then
          exit 1
        fi
        shift 2
        ;;
      --network)
        if [ $# -lt 2 ]; then
          printf "%bError:%b --network requires a network name\n" "${RED}" "${NORMAL}" >&2
          exit 1
        fi
        network_name="$2"
        shift 2
        ;;
      --dry-run)
        dry_run="true"
        shift
        ;;
      --*)
        printf "%bError:%b Unknown option: %s\n" "${RED}" "${NORMAL}" "$1" >&2
        usage
        ;;
      *)
        printf "%bError:%b Unexpected argument: %s\n" "${RED}" "${NORMAL}" "$1" >&2
        usage
        ;;
    esac
  done

  case "${cmd}" in
    k3d-up) k3d_up "${network_name}" ;;
    setup)
      script_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
      repo_root="$(cd "${script_dir}/.." && pwd)"
      k3s_dir="${repo_root}/k3s"

      # Resolve IP pool range according to flags/env
      if [ "${k3d_flag:-false}" = "true" ]; then
        net_to_use="${network_name:-k3d-local-cluster}"
        if ! docker network inspect "${net_to_use}" > /dev/null 2>&1; then
          echo "--k3d specified but docker network not found: ${net_to_use}" >&2
          echo "Provide an existing network with --network NAME or create the k3d cluster first." >&2
          exit 1
        fi
        subnet=$(docker network inspect "${net_to_use}" \
          | jq -r '.[0].IPAM.Config[0].Subnet')
        if [ -z "${subnet}" ] || [ "${subnet}" = "null" ]; then
          echo "Failed to detect subnet from network '${net_to_use}'. Is the cluster/network running?" >&2
          exit 1
        fi
        ip_pool_range="${subnet}"
        echo "k3d mode: using network '${net_to_use}' with IP pool ${ip_pool_range}"
      elif [ -n "${explicit_ip_pool}" ]; then
        ip_pool_range="${explicit_ip_pool}"
        echo "Using IP pool from --ip-pool: ${ip_pool_range}"
      elif [ -n "${IP_POOL_RANGE:-}" ]; then
        ip_pool_range="${IP_POOL_RANGE}"
        echo "Using IP pool from IP_POOL_RANGE env: ${ip_pool_range}"
      else
        echo "Error: Provide an IP pool via --ip-pool or IP_POOL_RANGE, or use --k3d to auto-detect." >&2
        echo "Example: --ip-pool 10.0.1.100-10.0.1.200" >&2
        exit 1
      fi

      if ! validate_ip_pool_range "${ip_pool_range}"; then
        echo "Invalid IP pool range: ${ip_pool_range}" >&2
        echo "Acceptable formats: A.B.C.D/NN or A.B.C.D-E.F.G.H" >&2
        exit 1
      fi

      echo "Installing Helm-based addons (MetalLB, ingress, etc.)..."
      kubectl apply -k "${k3s_dir}/helm-charts"

      echo "Waiting for cert-manager CRDs to be established..."
      for crd in certificates.cert-manager.io \
        issuers.cert-manager.io \
        clusterissuers.cert-manager.io; do
        timeout=180
        while ! kubectl get crd "${crd}" > /dev/null 2>&1; do
          if [ ${timeout} -le 0 ]; then
            echo "Timed out waiting for ${crd}" >&2
            exit 1
          fi
          sleep 2
          timeout=$((timeout - 2))
        done
      done

      echo "Waiting for cert-manager deployments to roll out..."
      kubectl -n cert-manager rollout status deploy/cert-manager --timeout=300s || true
      kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=300s || true
      kubectl -n cert-manager rollout status deploy/cert-manager-cainjector --timeout=300s || true

      echo "Waiting for MetalLB CRDs to be established..."
      timeout=120
      while ! kubectl get crd ipaddresspools.metallb.io > /dev/null 2>&1; do
        if [ ${timeout} -le 0 ]; then
          echo "Timed out waiting for ipaddresspools.metallb.io" >&2
          exit 1
        fi
        sleep 2
        timeout=$((timeout - 2))
      done

      timeout=120
      while ! kubectl get crd l2advertisements.metallb.io > /dev/null 2>&1; do
        if [ ${timeout} -le 0 ]; then
          echo "Timed out waiting for l2advertisements.metallb.io" >&2
          exit 1
        fi
        sleep 2
        timeout=$((timeout - 2))
      done

      kubectl -n metallb-system rollout status deploy/metallb-controller --timeout=300s

      echo "Applying core kustomization with IP pool range: ${ip_pool_range}"
      export IP_POOL_RANGE="${ip_pool_range}"
      kubectl kustomize "${k3s_dir}/core" --load-restrictor LoadRestrictionsNone \
        | envsubst \
        | kubectl apply -f -

      echo "Setup complete."
      ;;

    k3d-down) k3d_down ;;

    secrets)
      script_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
      repo_root="$(cd "${script_dir}/.." && pwd)"
      k3s_dir="${repo_root}/k3s"
      secrets_yaml="${k3s_dir}/apps/secrets.yaml"

      if [ ! -f "${secrets_yaml}" ]; then
        echo "Missing ${secrets_yaml}" >&2
        exit 1
      fi

      echo "Fetching SST secrets..." >&2
      if ! secrets_json=$(cd "${repo_root}" \
        && pnpm sst shell node scripts/secrets.js 2> /dev/null); then
        echo "Error: Failed to fetch SST secrets. Make sure you're authenticated with SST." >&2
        echo "Try running: pnpm sst shell" >&2
        exit 1
      fi

      # Create temp file to work with
      tmp_file=$(mktemp)
      trap 'rm -f "${tmp_file}"' EXIT
      cp "${secrets_yaml}" "${tmp_file}"

      # Extract all unique ${sst.Key} patterns from the secrets.yaml file
      sst_keys=$(grep -o '\${sst\.[^}]*}' "${secrets_yaml}" \
        | sed 's/\${sst\.//g' \
        | sed 's/}//g' \
        | sort -u)

      if [ -z "${sst_keys}" ]; then
        echo "No \${sst.Key} patterns found in ${secrets_yaml}" >&2
        exit 1
      fi

      echo "Found SST keys: $(echo "${sst_keys}" | tr '\n' ' ')" >&2

      # Replace placeholders with proper indentation
      for key in ${sst_keys}; do
        value=$(printf '%s' "${secrets_json}" \
          | jq -r --arg key "${key}" '.[$key].value // empty')

        if [ -z "${value}" ]; then
          echo "Warning: No value found for key: ${key}" >&2
          sed -i.bak "s/\${sst\.${key}}/MISSING_KEY_${key}/g" "${tmp_file}" \
            && rm -f "${tmp_file}.bak"
        else
          # Check if the placeholder is on its own line (for multi-line values like certificates)
          if grep -q "^[[:space:]]*\${sst\.${key}}[[:space:]]*$" "${tmp_file}"; then
            # Create a temporary file with the value, adding 4-space indentation to each line
            value_temp=$(mktemp)
            printf '%s\n' "${value}" | sed 's/^/    /' > "${value_temp}"

            # Replace the placeholder line with the indented content
            sed -i.bak "/^[[:space:]]*\${sst\.${key}}[[:space:]]*$/{
            r ${value_temp}
            d
          }" "${tmp_file}" && rm -f "${tmp_file}.bak"

            rm -f "${value_temp}"
          else
            # For inline placeholders (like in JSON), do safe string replacement
            safe_value=$(printf '%s' "${value}" | sed -e 's/[\\&|]/\\&/g')
            sed -i.bak "s|\${sst\.${key}}|${safe_value}|g" "${tmp_file}" \
              && rm -f "${tmp_file}.bak"
          fi
        fi
      done

      if [ "${dry_run}" = "true" ]; then
        cat "${tmp_file}"
        exit 0
      else
        kubectl apply -f "${tmp_file}"
      fi
      ;;
  esac
}

main "$@"
