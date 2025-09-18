#!/bin/sh
# TODO: use scp for copy
set -euo pipefail

usage() {
  echo "Usage: $0 {tunnel|stop-tunnel|status|copy} <ssh-target> [options]" >&2
  echo "  ssh-target example: pandoks@k3s-control-plane-0-dev.pandoks.com" >&2
  echo "" >&2
  echo "Commands:" >&2
  echo "  tunnel <ssh-target> --local-port <port> --remote-port <port>" >&2
  echo "      Start SSH local port-forward in background; prints PID." >&2
  echo "  stop-tunnel [--all]" >&2
  echo "      Stop all tunnels with --all, or pick via fzf." >&2
  echo "  status" >&2
  echo "      Show matching ssh port-forward processes (aligned)." >&2
  echo "  copy <ssh-target> --remote-file <path> [--out <local path>]" >&2
  echo "      Copy remote file via SSH (no scp). If --out omitted, uses ./basename(remote)." >&2
  exit 1
}

[ $# -ge 1 ] || usage

CMD="$1"
shift

case "$CMD" in
copy)
  # Parse target and flags in any order after subcommand
  TARGET=""
  REMOTE_FILE=""
  OUT_FILE=""
  SEEN_REMOTE_FILE=0
  SEEN_OUT=0
  while [ $# -gt 0 ]; do
    case "${1:-}" in

    --remote-file)
      [ $SEEN_REMOTE_FILE -eq 0 ] || {
        echo "--remote-file specified multiple times" >&2
        exit 1
      }
      SEEN_REMOTE_FILE=1
      shift
      [ $# -ge 1 ] || {
        echo "Missing value for --remote-file" >&2
        exit 1
      }
      REMOTE_FILE="$1"
      ;;
    --out)
      [ $SEEN_OUT -eq 0 ] || {
        echo "--out specified multiple times" >&2
        exit 1
      }
      SEEN_OUT=1
      shift
      [ $# -ge 1 ] || {
        echo "Missing value for --out" >&2
        exit 1
      }
      OUT_FILE="$1"
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage
      ;;
    *)
      if [ -z "$TARGET" ]; then
        TARGET="$1"
      else
        echo "Only one ssh target allowed" >&2
        exit 1
      fi
      ;;
    esac
    shift
  done
  [ -n "$TARGET" ] || usage
  [ -n "$REMOTE_FILE" ] || {
    echo "--remote-file is required" >&2
    exit 1
  }
  if [ -z "$OUT_FILE" ]; then
    OUT_FILE="./$(basename "$REMOTE_FILE")"
  fi
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  if ! ssh -o StrictHostKeyChecking=accept-new "$TARGET" "sudo cat \"$REMOTE_FILE\"" >"$tmp" 2>"$tmp.err"; then
    if grep -q "REMOTE HOST IDENTIFICATION HAS CHANGED" "$tmp.err"; then
      HOST_ONLY=$(printf "%s" "$TARGET" | sed 's/^[^@]*@//')
      echo "Host key changed for $HOST_ONLY, removing old key and retrying..." >&2
      ssh-keygen -R "$HOST_ONLY" >/dev/null 2>&1 || true
      if ! ssh -o StrictHostKeyChecking=accept-new "$TARGET" "sudo cat \"$REMOTE_FILE\"" >"$tmp"; then
        echo "Failed to copy $REMOTE_FILE from $TARGET" >&2
        exit 1
      fi
    else
      cat "$tmp.err" >&2 || true
      echo "Failed to copy $REMOTE_FILE from $TARGET" >&2
      exit 1
    fi
  fi
  mv "$tmp" "$OUT_FILE"
  chmod 600 "$OUT_FILE"
  echo "Wrote $OUT_FILE"
  ;;
tunnel)
  # Parse target and flags in any order after subcommand
  TARGET=""
  LOCAL_PORT=""
  REMOTE_PORT=""
  SEEN_LP=0
  SEEN_RP=0
  while [ $# -gt 0 ]; do
    case "${1:-}" in

    --local-port)
      [ $SEEN_LP -eq 0 ] || {
        echo "--local-port specified multiple times" >&2
        exit 1
      }
      SEEN_LP=1
      shift
      [ $# -ge 1 ] || {
        echo "Missing value for --local-port" >&2
        exit 1
      }
      LOCAL_PORT="$1"
      echo "$LOCAL_PORT" | awk 'BEGIN{ok=1} { if ($0 !~ /^[0-9]+$/) ok=0; else { n=$0+0; if (n<1 || n>65535) ok=0 } } END{ exit ok?0:1 }' || {
        echo "--local-port must be an integer between 1 and 65535" >&2
        exit 1
      }
      ;;
    --remote-port)
      [ $SEEN_RP -eq 0 ] || {
        echo "--remote-port specified multiple times" >&2
        exit 1
      }
      SEEN_RP=1
      shift
      [ $# -ge 1 ] || {
        echo "Missing value for --remote-port" >&2
        exit 1
      }
      REMOTE_PORT="$1"
      echo "$REMOTE_PORT" | awk 'BEGIN{ok=1} { if ($0 !~ /^[0-9]+$/) ok=0; else { n=$0+0; if (n<1 || n>65535) ok=0 } } END{ exit ok?0:1 }' || {
        echo "--remote-port must be an integer between 1 and 65535" >&2
        exit 1
      }
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage
      ;;
    *)
      if [ -z "$TARGET" ]; then
        TARGET="$1"
      else
        echo "Only one ssh target allowed" >&2
        exit 1
      fi
      ;;
    esac
    shift
  done
  [ -n "$TARGET" ] || usage
  [ -n "$LOCAL_PORT" ] || {
    echo "--local-port is required" >&2
    exit 1
  }
  [ -n "$REMOTE_PORT" ] || {
    echo "--remote-port is required" >&2
    exit 1
  }

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
  # Start once; if host key changed, remove and retry once
  ssh -N -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" "$TARGET" >/dev/null 2>"/tmp/k3s-ssh.${LOCAL_PORT}.err" &
  PID=$!
  sleep 0.15
  if ! kill -0 "$PID" 2>/dev/null; then
    if grep -q "REMOTE HOST IDENTIFICATION HAS CHANGED" "/tmp/k3s-ssh.${LOCAL_PORT}.err" 2>/dev/null; then
      HOST_ONLY=$(printf "%s" "$TARGET" | sed 's/^[^@]*@//')
      echo "Host key changed for $HOST_ONLY, removing old key and retrying..." >&2
      ssh-keygen -R "$HOST_ONLY" >/dev/null 2>&1 || true
      ssh -N -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" "$TARGET" >/dev/null 2>&1 &
      PID=$!
      sleep 0.15
    fi
  fi
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
  ALL=0
  if [ "${1:-}" = "--all" ]; then
    ALL=1
    shift
  fi
  rows="$(ps -axo pid,user,command | awk '
    NR==1 { next }
    /ssh[[:space:]]+-N[[:space:]]+-L/ {
      pid=$1; user=$2;
      cmd=""; for(i=3;i<=NF;i++) cmd = cmd (i==3?"":OFS) $i;
      map="";
      for (i=3;i<=NF;i++) {
        if ($i == "-L" && (i+1)<=NF) { map=$(i+1); break }
        if ($i ~ /^-L/) { sub(/^-L/, "", $i); map=$i; break }
      }
      printf "%-6s %-10s %-23s %s\n", pid, user, map, cmd
    }')"
  if [ -z "$rows" ]; then
    echo "No tunnels found."
    exit 0
  fi
  if [ $ALL -eq 1 ]; then
    echo "$rows" | awk '{ pid=$1; if (pid ~ /^[0-9]+$/) print pid }' | while read -r pid; do
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" || true
        echo "Stopped PID $pid"
      fi
    done
    exit 0
  fi
  command -v fzf >/dev/null 2>&1 || {
    echo "fzf not found. Install fzf to use stop-tunnel picker." >&2
    exit 1
  }
  header="$(printf "%-6s %-10s %-23s %s\n" "PID" "USER" "LOCAL->REMOTE" "COMMAND")"
  selection="$(printf "%s\n" "$rows" | fzf -m --no-sort --header="$header")"
  [ -n "$selection" ] || exit 0
  echo "$selection" | awk '{ pid=$1; if (pid ~ /^[0-9]+$/) print pid }' | while read -r pid; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" || true
      echo "Stopped PID $pid"
    fi
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
        if ($i ~ /^-L/) { sub(/^-L/, "", $i); map=$i; break }
      }
      printf "%-6s %-10s %-23s %s\n", pid, user, map, cmd
    }'
  ;;
*)
  usage
  ;;
esac
