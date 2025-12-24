# shellcheck shell=sh

cmd_deps_up() {
  if [ $# -gt 0 ]; then
    printf "%bError:%b Unexpected argument for deps up: %s\n" "${RED}" "${NORMAL}" "$1" >&2
    exit 1
  fi

  echo "Starting docker compose dependencies..."
  docker compose -f ./docker-compose.yaml -p deps up -d
  printf "%b✓ docker compose dependencies started%b\n" "${GREEN}" "${NORMAL}"
}

cmd_deps_down() {
  if [ $# -gt 0 ]; then
    printf "%bError:%b Unexpected argument for deps down: %s\n" "${RED}" "${NORMAL}" "$1" >&2
    exit 1
  fi

  echo "Stopping docker compose dependencies..."
  docker compose -f ./docker-compose.yaml -p deps down
  printf "%b✓ docker compose dependencies stopped%b\n" "${GREEN}" "${NORMAL}"
}

cmd_deps_restart() {
  if [ $# -gt 0 ]; then
    printf "%bError:%b Unexpected argument for deps restart: %s\n" "${RED}" "${NORMAL}" "$1" >&2
    exit 1
  fi

  echo "Restarting docker compose dependencies..."
  cmd_deps_down
  cmd_deps_up
  printf "%b✓ docker compose dependencies restarted%b\n" "${GREEN}" "${NORMAL}"
}

cmd_deps() {
  [ $# -ge 1 ] || usage_deps 1
  subcmd="$1"
  shift

  case "${subcmd}" in
    up) cmd_deps_up "$@" ;;
    down) cmd_deps_down "$@" ;;
    restart) cmd_deps_restart "$@" ;;
    help|--help|-h) usage_deps ;;
    *)
      printf "%bError:%b Unknown deps subcommand '%s'\n" "${RED}" "${NORMAL}" "${subcmd}" >&2
      usage_deps 1
      ;;
  esac
}
