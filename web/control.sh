#!/bin/bash
# Live Show Manager — Server Control
# =====================================
# Starts/stops the Node.js bridge server with zero-overhead monitoring.
# Uses macOS launchd for auto-restart on crash (kernel-level, no polling).
#
# Usage:
#   ./control.sh start       Start server with launchd (auto-restart on crash)
#   ./control.sh stop        Stop server
#   ./control.sh status      Check if server is running
#   ./control.sh direct      Start directly in foreground (for debugging)
#
# launchd uses kernel-level process monitoring (mach ports), not polling.
# Zero CPU overhead when running. Server auto-restarts if it crashes.

DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$DIR/com.liveshowmanager.bridge.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.liveshowmanager.bridge.plist"
LOG_DIR="$DIR/logs"
SERVER_LOG="$LOG_DIR/server.log"
ERR_LOG="$LOG_DIR/server-error.log"

mkdir -p "$LOG_DIR"

case "${1:-status}" in
  start)
    # Copy plist to LaunchAgents and load via launchd
    cp "$PLIST" "$PLIST_DEST"
    launchctl load "$PLIST_DEST" 2>&1
    echo "Server started (launchd KeepAlive active, zero CPU overhead)"
    echo "Logs: $SERVER_LOG"
    ;;
  stop)
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
    rm -f "$PLIST_DEST"
    echo "Server stopped"
    ;;
  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;
  status)
    # launchctl exit code: 0=running, 1=not found, other=various
    if launchctl list com.liveshowmanager.bridge >/dev/null 2>&1; then
      echo "Server: RUNNING"
      launchctl list com.liveshowmanager.bridge
    elif [ -f "$PLIST_DEST" ]; then
      echo "Server: LOADED (but process may not be active)"
    else
      # Check if running directly (bypassing launchd)
      PID=$(pgrep -f "node.*server\.js" 2>/dev/null || true)
      if [ -n "$PID" ]; then
        echo "Server: RUNNING (direct mode, PID $PID)"
      else
        echo "Server: STOPPED"
      fi
    fi
    curl -s http://localhost:3000/api/discover 2>/dev/null || echo "API unreachable"
    ;;
  direct)
    echo "Starting directly (debug mode). Press Ctrl+C to stop."
    node "$DIR/server.js"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|direct}"
    exit 1
    ;;
esac
