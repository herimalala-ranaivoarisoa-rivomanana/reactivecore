#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

logs=$(mktemp -d)
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  wait || true
  rm -f "$logs/"{inventory.log,tasks.log,restart,restart.ready}
  rmdir "$logs"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start() {
  local application=$1
  setsid node scripts/module05-lab.mjs "platform-$application" >> "$logs/$application.log" 2>&1 &
  pids+=("$!")
}

ready() {
  local port=$1
  for _ in {1..40}; do
    if curl -fsS --max-time 1 "http://127.0.0.1:$port/api/health/ready" >/dev/null 2>&1; then return; fi
    sleep .25
  done
  cat "$logs/inventory.log" "$logs/tasks.log" >&2
  return 1
}

start inventory
start tasks
ready 4401
ready 4402

RC_RESTART_MARKER="$logs/restart" node --env-file=.env.module05-lab scripts/platform-demo.mjs &
demo_pid=$!
for _ in {1..100}; do
  if [[ -f "$logs/restart" ]]; then break; fi
  if ! kill -0 "$demo_pid" 2>/dev/null; then break; fi
  sleep .05
done

if [[ -f "$logs/restart" ]]; then
  task_pid=${pids[1]}
  kill -TERM -- "-$task_pid"
  wait "$task_pid" || true
  start tasks
  ready 4402
  touch "$logs/restart.ready"
fi

if ! wait "$demo_pid"; then
  cat "$logs/inventory.log" "$logs/tasks.log" >&2
  exit 1
fi
