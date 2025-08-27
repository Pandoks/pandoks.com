#!/bin/sh
set -euo pipefail

usage() {
  echo "Usage: $0 {tunnel|stop-tunnel|status} <ssh-target> [options]" >&2
  echo "  ssh-target example: pandoks@k3s-control-plane-0-dev.pandoks.com" >&2
  echo "" >&2
  echo "Commands:" >&2
  echo "  tunnel <ssh-target> [--local-port 6443] [--remote-port 6443]" >&2
  echo "      Start SSH local port-forward in background; prints PID." >&2
  echo "  stop-tunnel" >&2
  echo "      Pick and stop tunnels via fzf." >&2
  echo "  status" >&2
  echo "      Show matching ssh port-forward processes (aligned)." >&2
  exit 1
}

[ $# -ge 1 ] || usage

CMD="$1"
shift

case "$CMD" in
  tunnel)
    [ $# -ge 1 ] || usage
    TARGET="$1"
    shift
    LOCAL_PORT=6443
    REMOTE_PORT=6443
  while [ $# -gt 0 ]; do
    case "${1:-}" in
    --local-port)
      LOCAL_PORT="${2:-}"
      shift 2
      ;;
    --remote-port)
      REMOTE_PORT="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      ;;
    esac
  done
    # Acquire per-port lock to avoid races on rapid invocations
    LOCKDIR="/tmp/k3s-ssh.${LOCAL_PORT}.lock"
    LOCK_TRIES=50
    i=0
    while ! mkdir "$LOCKDIR" 2>/dev/null; do
      i=$(expr "$i" + 1)
      if [ "$i" -ge "$LOCK_TRIES" ]; then
        echo "Another tunnel setup is in progress for port ${LOCAL_PORT}. Try again." >&2
        exit 1
      fi
      sleep 0.1
    done
    cleanup_lock() { rmdir "$LOCKDIR" 2>/dev/null || true; }
    trap cleanup_lock EXIT INT TERM

    # Refuse if an ssh tunnel for this local port is already starting/running (even if not yet LISTENing)
    if ps -axo pid,command | awk '
      /ssh[[:space:]]+-N[[:space:]]+-L/ {
        for (i=1;i<=NF;i++) {
          if ($i=="-L" && (i+1)<=NF && $(i+1) ~ /^'"${LOCAL_PORT}"':[0-9.]+:[0-9]+$/) { print; exit 0 }
          if ($i ~ /^-L'"${LOCAL_PORT}"':[0-9.]+:[0-9]+$/) { print; exit 0 }
        }
      }' | grep -q .; then
      echo "Tunnel for local port ${LOCAL_PORT} already in progress or running. Use --local-port to choose a different port." >&2
      exit 1
    fi

    echo "Starting tunnel in background: localhost:${LOCAL_PORT} -> $TARGET 127.0.0.1:${REMOTE_PORT}"
    ssh -N -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" "$TARGET" >/dev/null 2>&1 &
    PID=$!
    # Verify ssh actually started
    sleep 0.15
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "Failed to start tunnel. Port ${LOCAL_PORT} may be in use or SSH failed." >&2
      exit 1
    fi
    command -v disown >/dev/null 2>&1 && disown || true
    echo "Tunnel started. PID ${PID}"
    ;;

stop-tunnel)
  command -v fzf >/dev/null 2>&1 || {
    echo "fzf not found. Install fzf to use stop-tunnel picker." >&2
    exit 1
  }
  header="$(printf "%-6s %-10s %-23s %s\n" "PID" "USER" "LOCAL->REMOTE" "COMMAND")"
  while :; do
    rows="$(ps -axo pid,user,command | awk '
      NR==1 { next }
      /ssh[[:space:]]+-N[[:space:]]+-L/ {
        pid=$1; user=$2;
        cmd=""; for(i=3;i<=NF;i++) cmd = cmd (i==3?"":OFS) $i;
        map="";
        for (i=3;i<=NF;i++) {
          if ($i == "-L" && (i+1)<=NF) { map=$(i+1); break }
          if ($i ~ /^-L/) { gsub(/^-([lL])/, "", $i); map=$i; break }
        }
        printf "%-6s %-10s %-23s %s\n", pid, user, map, cmd
      }')"
    if [ -z "$rows" ]; then
      echo "No tunnels found."
      exit 0
    fi
    selection="$(printf "%s\n" "$rows" | fzf -m --no-sort --header="$header")"
    [ -n "$selection" ] || exit 0
    echo "$selection" | awk '{ pid=$1; if (pid ~ /^[0-9]+$/) print pid }' | while read -r pid; do
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" || true
        echo "Stopped PID $pid"
      fi
    done
  done
  ;;
status)
  printf "%-6s %-10s %-23s %s\n" "PID" "USER" "LOCAL->REMOTE" "COMMAND"
  ps -axo pid,user,command | awk '
    NR==1 { next }
    /ssh[[:space:]]+-N[[:space:]]+-L/ {
      pid=$1; user=$2;
      cmd=""; for(i=3;i<=NF;i++) cmd = cmd (i==3?"":OFS) $i;
      map="";
      for (i=3;i<=NF;i++) {
        if ($i == "-L" && (i+1)<=NF) { map=$(i+1); break }
        if ($i ~ /^-L/) { gsub(/^-([lL])/,"",$i); map=$i; break }
      }
      printf "%-6s %-10s %-23s %s\n", pid, user, map, cmd
    }'
  ;;
*)
  usage
  ;;
esac
