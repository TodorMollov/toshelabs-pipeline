#!/bin/bash
cd "$(dirname "$0")"
PIDFILE=".server.pid"

case "${1:-start}" in
  stop)
    if [ -f "$PIDFILE" ]; then
      kill "$(cat "$PIDFILE")" 2>/dev/null && echo "Stopped." || echo "Not running."
      rm -f "$PIDFILE"
    else
      echo "No pidfile — killing by name..."
      pkill -f "node src/index.js --server" && echo "Stopped." || echo "Not running."
    fi
    ;;
  restart)
    "$0" stop
    sleep 1
    "$0" start "${@:2}"
    ;;
  start|*)
    [ "$1" = "start" ] && shift
    "$0" stop 2>/dev/null
    sleep 0.5
    # rotate previous log once so we keep one generation
    [ -f pipeline.log ] && mv -f pipeline.log pipeline.log.1
    node src/index.js --server "$@" >> pipeline.log 2>&1 &
    echo $! > "$PIDFILE"
    echo "Started (PID $(cat "$PIDFILE"))"
    ;;
esac
