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
  # 30s ceiling: when stop is hard-killing a step, the kernel needs a
  # second or two to reap the listening socket after the parent exits.
  # 10s was too short — a Pipeline mid-`flutter test` could take 10-15s
  # to wind down and the next `start` would race the port and fall into
  # the "running without UI server" zombie path. 30s × 200ms = 150 polls.
  while [ "$i" -lt 150 ]; do
    if ! ss -tln "sport = :${PORT}" 2>/dev/null | grep -q ":${PORT}\b"; then
      return 0
    fi
    sleep 0.2
    i=$((i + 1))
  done
  echo "ERROR: port ${PORT} still bound after 30s wait — refusing to start" >&2
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
    # If port is still bound after stop's wait, refuse to start. The
    # alternative — letting node start anyway and fall into its
    # "Port already in use — running without UI server" path — produces
    # a zombie process that's alive but not serving anything (no
    # dashboard, no MCP, no /api/*). The operator only notices when a
    # subsequent /api/projects/refresh times out, by which point
    # whatever they're trying to do has been silently broken for hours.
    # Better to fail loud here.
    if ! wait_port_free; then
      echo "ERROR: refusing to start — port ${PORT} is held by another process. Run \`./start.sh stop\` and check \`ss -tlnp | grep ${PORT}\`." >&2
      exit 1
    fi
    # rotate previous log once so we keep one generation
    [ -f pipeline.log ] && mv -f pipeline.log pipeline.log.1
    NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}" node src/index.js --server "$@" >> pipeline.log 2>&1 &
    echo $! > "$PIDFILE"
    echo "Started (PID $(cat "$PIDFILE"))"
    ;;
esac
