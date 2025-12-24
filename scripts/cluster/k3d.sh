# shellcheck shell=sh

. "$(dirname "$0")/deps.sh"

cmd_k3d_up() {
  cmd_k3d_up_network_name=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --network)
        if [ $# -lt 2 ]; then
          printf "%bError:%b --network requires a network name\n" "${RED}" "${NORMAL}" >&2
          exit 1
        fi
        cmd_k3d_up_network_name="$2"
        shift 2
        ;;
      *)
        printf "%bError:%b Unexpected argument for k3d up: %s\n" "${RED}" "${NORMAL}" "$1" >&2
        exit 1
        ;;
    esac
  done

  if k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    echo "k3d cluster 'local-cluster' already exists. Skipping creation."
    return 0
  fi

  echo "Creating k3d cluster 'local-cluster'..."
  if [ -n "${cmd_k3d_up_network_name}" ]; then
    if ! docker network inspect "${cmd_k3d_up_network_name}" > /dev/null 2>&1; then
      printf "%bError:%b docker network not found: %s\n" "${RED}" "${NORMAL}" "${cmd_k3d_up_network_name}" >&2
      return 1
    fi
    cmd_k3d_up_network_args="--network ${cmd_k3d_up_network_name}"
    echo "Attaching loadbalancer to docker network: ${cmd_k3d_up_network_name}"
  fi

  # shellcheck disable=SC2086
  k3d cluster create local-cluster \
    --servers 3 \
    --agents 3 \
    --registry-create local-registry:12345 \
    --api-port 6444 \
    --k3s-arg "--disable=traefik@server:*" \
    --k3s-arg "--disable=servicelb@server:*" \
    -p "8080:30080@loadbalancer" \
    ${cmd_k3d_up_network_args:-}
  printf "%b✓ k3d cluster created%b\n" "${GREEN}" "${NORMAL}"
}

cmd_k3d_down() {
  if [ $# -gt 0 ]; then
    printf "%bError:%b Unexpected argument for k3d down: %s\n" "${RED}" "${NORMAL}" "$1" >&2
    exit 1
  fi

  if ! k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    echo "k3d cluster 'local-cluster' not found. Nothing to delete."
    return 0
  fi

  echo "Deleting k3d cluster 'local-cluster'..."
  k3d cluster delete local-cluster
  printf "%b✓ k3d cluster deleted%b\n" "${GREEN}" "${NORMAL}"
}

cmd_k3d_start() {
  if [ $# -gt 0 ]; then
    printf "%bError:%b Unexpected argument for k3d start: %s\n" "${RED}" "${NORMAL}" "$1" >&2
    exit 1
  fi

  if ! k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    echo "k3d cluster 'local-cluster' not found. Nothing to start."
    return 0
  fi

  echo "Starting k3d cluster 'local-cluster'..."
  k3d cluster start local-cluster
  printf "%b✓ k3d cluster started%b\n" "${GREEN}" "${NORMAL}"
}

cmd_k3d_stop() {
  if [ $# -gt 0 ]; then
    printf "%bError:%b Unexpected argument for k3d stop: %s\n" "${RED}" "${NORMAL}" "$1" >&2
    exit 1
  fi

  if ! k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    echo "k3d cluster 'local-cluster' not found. Nothing to stop."
    return 0
  fi

  echo "Stopping k3d cluster 'local-cluster'..."
  k3d cluster stop local-cluster
  printf "%b✓ k3d cluster stopped%b\n" "${GREEN}" "${NORMAL}"
}

cmd_k3d_restart() {
  if [ $# -gt 0 ]; then
    printf "%bError:%b Unexpected argument for k3d restart: %s\n" "${RED}" "${NORMAL}" "$1" >&2
    exit 1
  fi

  if ! k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    echo "k3d cluster 'local-cluster' not found. Nothing to restart."
    return 0
  fi

  echo "Restarting k3d cluster 'local-cluster'..."
  cmd_k3d_stop
  cmd_k3d_start
  printf "%b✓ k3d cluster restarted%b\n" "${GREEN}" "${NORMAL}"
}

cmd_k3d() {
  [ $# -ge 1 ] || usage_k3d 1
  subcmd="$1"
  shift

  case "${subcmd}" in
    up) cmd_k3d_up "$@" ;;
    down) cmd_k3d_down "$@" ;;
    start) cmd_k3d_start "$@" ;;
    stop) cmd_k3d_stop "$@" ;;
    restart) cmd_k3d_restart "$@" ;;
    deps) cmd_deps "$@" ;;
    help | --help | -h) usage_k3d ;;
    *)
      printf "%bError:%b Unknown k3d subcommand '%s'\n" "${RED}" "${NORMAL}" "${subcmd}" >&2
      usage_k3d 1
      ;;
  esac
}
