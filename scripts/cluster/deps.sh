# shellcheck shell=sh

cmd_deps_up() {
  if [ $# -gt 0 ]; then
    die "Unexpected argument for deps up: $1"
  fi

  echo "Starting docker compose dependencies..."
  docker compose -f ./docker-compose.yaml -p deps up -d
  log_ok "docker compose dependencies started"
}

cmd_deps_down() {
  if [ $# -gt 0 ]; then
    die "Unexpected argument for deps down: $1"
  fi

  echo "Stopping docker compose dependencies..."
  docker compose -f ./docker-compose.yaml -p deps down
  log_ok "docker compose dependencies stopped"
}

cmd_deps_restart() {
  if [ $# -gt 0 ]; then
    die "Unexpected argument for deps restart: $1"
  fi

  echo "Restarting docker compose dependencies..."
  cmd_deps_down
  cmd_deps_up
  log_ok "docker compose dependencies restarted"
}

cmd_deps() {
  [ $# -ge 1 ] || usage_deps 1
  cmd_deps_subcmd="$1"
  shift

  case "${cmd_deps_subcmd}" in
    up) cmd_deps_up "$@" ;;
    down) cmd_deps_down "$@" ;;
    restart) cmd_deps_restart "$@" ;;
    help | --help | -h) usage_deps ;;
    *)
      log_error "Unknown deps subcommand '${cmd_deps_subcmd}'"
      usage_deps 1
      ;;
  esac
}
