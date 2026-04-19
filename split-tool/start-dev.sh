#!/bin/sh

set -e

cd "$(dirname "$0")"

PORT="${PORT:-5175}"

# 自动清理占用目标端口的所有旧进程
OLD_PIDS=$(lsof -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "$OLD_PIDS" ]; then
  echo "Killing old processes on port $PORT: $OLD_PIDS"
  echo "$OLD_PIDS" | while read pid; do
    kill -9 "$pid" 2>/dev/null || true
  done
  # 等待端口彻底释放（最多 10 秒）
  WAIT=0
  while lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
    WAIT=$((WAIT + 1))
    if [ "$WAIT" -ge 10 ]; then
      echo "ERROR: port $PORT still occupied after 10s, aborting"
      exit 1
    fi
    sleep 1
  done
  echo "Port $PORT is now free"
fi

echo "Starting Vite on port $PORT"
exec npx vite --port "$PORT"
