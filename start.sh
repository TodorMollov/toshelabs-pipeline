#!/bin/bash
cd "$(dirname "$0")"
PIDFILE=".server.pid"
PORT="${PIPELINE_PORT:-3847}"

# Wait until the listening port is actually free. Without this, the new
# server starts before the old one fully releases :3847 and gets the
# "Port 3847 already in use — running without UI server" fallback path,
# which silently leaves the old process serving requests with stale
# state. Polls every 200ms up to 10s; gives up loud rather than
# proceeding into a broken state.
wait_port_free() {
  local i=0
  while [ "$i" -lt 50 ]; do
    if ! ss -tln "sport = :${PORT}" 2>/dev/null | grep -q ":${PORT}\b"; then
      return 0
    fi
    sleep 0.2
    i=$((i + 1))
  done
  echo "warning: port ${PORT} still bound after 10s wait" >&2
  return 1
}

case "${1:-start}" in
  stop)
    if [ -f "$PIDFILE" ]; then
      kill "$(cat "$PIDFILE")" 2>/dev/null && echo "Stopped (pidfile)." || true
      rm -f "$PIDFILE"
    fi
    # Always sweep by name afterward — catches processes started outside
    # the script (e.g. left over from an earlier session) that the pidfile
    # never knew about. Without this, port stays held and the next
    # `start` becomes a zombie that can't bind.
    pkill -f "node src/index.js --server" 2>/dev/null && echo "Swept stragglers." || true
    # Wait for the kernel to actually release the port. SIGTERM doesn't
    # close listening sockets synchronously; the kernel reaps them after
    # the process exits. Even after pkill returns 0, the next bind() can
    # fail with EADDRINUSE for ~hundreds of ms. Poll instead of guessing.
    wait_port_free || true
    ;;
  restart)
    "$0" stop
    "$0" start "${@:2}"
    ;;
  start|*)
    [ "$1" = "start" ] && shift
    "$0" stop 2>/dev/null
    # rotate previous log once so we keep one generation
    [ -f pipeline.log ] && mv -f pipeline.log pipeline.log.1
    NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}" node src/index.js --server "$@" >> pipeline.log 2>&1 &
    echo $! > "$PIDFILE"
    echo "Started (PID $(cat "$PIDFILE"))"
    ;;
esac
