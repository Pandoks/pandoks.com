# shellcheck shell=sh

. "$(dirname "$0")/deps.sh"

cmd_k3d_up() {
  if [ $# -gt 0 ]; then
    die "Unexpected argument for k3d up: $1"
  fi

  if k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    echo "k3d cluster 'local-cluster' already exists. Skipping creation."
    return 0
  fi

  if ! docker network inspect pandoks-net > /dev/null 2>&1; then
    log_error "docker network 'pandoks-net' not found."
    printf "Run 'docker compose up -d' first to create the network.\n" >&2
    return 1
  fi

  echo "Fetching latest stable k3s version..."
  cmd_k3d_up_k3s_version=$(curl -sL https://update.k3s.io/v1-release/channels | jq -r '.data[] | select(.id == "stable") | .latest')
  if [ -z "${cmd_k3d_up_k3s_version}" ]; then
    log_error "Failed to fetch latest k3s version"
    return 1
  fi
  cmd_k3d_up_k3s_image="rancher/k3s:$(echo "${cmd_k3d_up_k3s_version}" | tr '+' '-')"
  echo "Using k3s image: ${cmd_k3d_up_k3s_image}"

  echo "Creating k3d cluster 'local-cluster' on network 'pandoks-net'..."
  k3d cluster create local-cluster \
    --image "${cmd_k3d_up_k3s_image}" \
    --servers 3 \
    --agents 3 \
    --registry-create local-registry:12345 \
    --api-port 6444 \
    --k3s-arg "--disable=traefik@server:*" \
    --k3s-arg "--disable=servicelb@server:*" \
    --k3s-arg "--etcd-expose-metrics@server:*" \
    -p "8080:30080@loadbalancer" \
    --network pandoks-net
  log_ok "k3d cluster created"
}

cmd_k3d_down() {
  if [ $# -gt 0 ]; then
    die "Unexpected argument for k3d down: $1"
  fi

  if ! k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    echo "k3d cluster 'local-cluster' not found. Nothing to delete."
    return 0
  fi

  echo "Deleting k3d cluster 'local-cluster'..."
  k3d cluster delete local-cluster
  log_ok "k3d cluster deleted"
}

cmd_k3d_start() {
  if [ $# -gt 0 ]; then
    die "Unexpected argument for k3d start: $1"
  fi

  if ! k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    echo "k3d cluster 'local-cluster' not found. Nothing to start."
    return 0
  fi

  echo "Starting k3d cluster 'local-cluster'..."
  k3d cluster start local-cluster
  log_ok "k3d cluster started"
}

cmd_k3d_stop() {
  if [ $# -gt 0 ]; then
    die "Unexpected argument for k3d stop: $1"
  fi

  if ! k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    echo "k3d cluster 'local-cluster' not found. Nothing to stop."
    return 0
  fi

  echo "Stopping k3d cluster 'local-cluster'..."
  k3d cluster stop local-cluster
  log_ok "k3d cluster stopped"
}

cmd_k3d_restart() {
  if [ $# -gt 0 ]; then
    die "Unexpected argument for k3d restart: $1"
  fi

  if ! k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    echo "k3d cluster 'local-cluster' not found. Nothing to restart."
    return 0
  fi

  echo "Restarting k3d cluster 'local-cluster'..."
  cmd_k3d_stop
  cmd_k3d_start
  log_ok "k3d cluster restarted"
}

cmd_k3d() {
  [ $# -ge 1 ] || usage_k3d 1
  cmd_k3d_subcmd="$1"
  shift

  case "${cmd_k3d_subcmd}" in
    up) cmd_k3d_up "$@" ;;
    down) cmd_k3d_down "$@" ;;
    start) cmd_k3d_start "$@" ;;
    stop) cmd_k3d_stop "$@" ;;
    restart) cmd_k3d_restart "$@" ;;
    deps) cmd_deps "$@" ;;
    help | --help | -h) usage_k3d ;;
    *)
      log_error "Unknown k3d subcommand '${cmd_k3d_subcmd}'"
      usage_k3d 1
      ;;
  esac
}
