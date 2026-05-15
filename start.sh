#!/bin/bash
cd "$(dirname "$0")"
PIDFILE=".server.pid"
PORT="${PIPELINE_PORT:-3847}"

# Stop pattern (operator-requested 2026-05-05):
#   1. Send SIGTERM to every node-pipeline process we know about.
#   2. Poll every 1s checking whether the port is actually free.
#   3. After 10s of polling, if anything's still bound, SIGKILL and
#      poll one more second to confirm. SIGKILL is unconditional —
#      after step 3 the port MUST be free or we refuse to start.
#
# Why this shape: SIGTERM lets the running server flush ops logs, release
# code locks, and unwatchFile cleanly. We give it 10s to do that. If it
# can't (mid-`flutter test`, mid-Claude-step, deadlocked), SIGKILL is
# decisive. Either way, total wait is bounded at ~11s.
#
# Port-as-success-signal: checking the port is more reliable than checking
# the PID, because PID reuse + multi-process scenarios make "is THIS pid
# alive" unreliable. If the port's free, the kernel has reaped the listening
# socket — that means the process binding it is gone.

list_pids() {
  # Every process matching our server invocation. Includes ones started
  # outside this script (manual `node src/index.js --server`).
  pgrep -f "node src/index.js --server" 2>/dev/null
}

port_is_free() {
  ! ss -tln "sport = :${PORT}" 2>/dev/null | grep -q ":${PORT}\b"
}

stop_and_wait() {
  # 1. Send SIGTERM to known pid + sweep by name.
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  pkill -TERM -f "node src/index.js --server" 2>/dev/null || true

  # 2. Poll every 1s up to 10s for graceful shutdown.
  local waited=0
  while [ "$waited" -lt 10 ]; do
    if port_is_free && [ -z "$(list_pids)" ]; then
      [ "$waited" -gt 0 ] && echo "Stopped after ${waited}s."
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  # 3. SIGKILL anything still alive; one more 1s check.
  echo "Graceful stop didn't finish in 10s — SIGKILL." >&2
  pkill -KILL -f "node src/index.js --server" 2>/dev/null || true
  sleep 1
  if port_is_free; then
    echo "Stopped (after SIGKILL)."
    return 0
  fi
  echo "ERROR: port ${PORT} still bound after SIGKILL. Inspect with \`ss -tlnp | grep ${PORT}\`." >&2
  return 1
}

case "${1:-start}" in
  stop)
    stop_and_wait
    ;;
  restart)
    "$0" stop || exit 1
    "$0" start "${@:2}"
    ;;
  start|*)
    [ "$1" = "start" ] && shift
    # stop_and_wait is a no-op if nothing's running; safe to call
    # before every start so no orphan can interfere with the new bind.
    stop_and_wait || exit 1
    # rotate previous log once so we keep one generation
    [ -f pipeline.log ] && mv -f pipeline.log pipeline.log.1
    # Run in the foreground and stream logs to this terminal while still
    # teeing to pipeline.log (rotation, .server.pid, and stop_and_wait's
    # pgrep all keep working). Process substitution keeps $! = node's pid,
    # not tee's. Ctrl+C stops the server cleanly.
    NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}" node src/index.js --server "$@" > >(tee -a pipeline.log) 2>&1 &
    NODE_PID=$!
    echo "$NODE_PID" > "$PIDFILE"
    echo "Started (PID $NODE_PID) — logs streaming below, also in pipeline.log. Ctrl+C to stop."
    wait "$NODE_PID"
    ;;
esac
