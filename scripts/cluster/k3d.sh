# shellcheck shell=sh

. "$(dirname "$0")/deps.sh"

cmd_k3d_up() {
  if [ $# -gt 0 ]; then
    printf "%bError:%b Unexpected argument for k3d up: %s\n" "${RED}" "${NORMAL}" "$1" >&2
    exit 1
  fi

  if k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    echo "k3d cluster 'local-cluster' already exists. Skipping creation."
    return 0
  fi

  if ! docker network inspect pandoks-net > /dev/null 2>&1; then
    printf "%bError:%b docker network 'pandoks-net' not found.\n" "${RED}" "${NORMAL}" >&2
    printf "Run 'docker compose up -d' first to create the network.\n" >&2
    return 1
  fi

  echo "Creating k3d cluster 'local-cluster' on network 'pandoks-net'..."
  k3d cluster create local-cluster \
    --servers 3 \
    --agents 3 \
    --registry-create local-registry:12345 \
    --api-port 6444 \
    --k3s-arg "--disable=traefik@server:*" \
    --k3s-arg "--disable=servicelb@server:*" \
    -p "8080:30080@loadbalancer" \
    --network pandoks-net
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
      printf "%bError:%b Unknown k3d subcommand '%s'\n" "${RED}" "${NORMAL}" "${cmd_k3d_subcmd}" >&2
      usage_k3d 1
      ;;
  esac
}
