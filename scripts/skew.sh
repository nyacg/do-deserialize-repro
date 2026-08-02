#!/usr/bin/env bash
# Cross-build skew repro: write a V8-serialized DO storage value with one
# workerd build, read it back with another. A format-version bump between
# the two builds reproduces the production error exactly:
#   "Unable to deserialize cloned data due to invalid or unsupported version."
#
# Usage: scripts/skew.sh <writer-workerd-version> <reader-workerd-version>
# e.g.:  scripts/skew.sh 1.20260801.1 1.20260710.1
#
# Writing with NEW and reading with OLD models the production incident:
# the DO host got the new build first (or last), and the stale peer could
# not read its payloads.
set -euo pipefail
cd "$(dirname "$0")/.."

WRITER="${1:?writer workerd version required}"
READER="${2:?reader workerd version required}"
PORT=8787

fetch_json() { curl -sS "http://127.0.0.1:$PORT$1"; }

run_workerd() {
  local version="$1"
  local dir=".workerd-cache/$version"
  if [ ! -x "$dir/node_modules/.bin/workerd" ]; then
    mkdir -p "$dir"
    (cd "$dir" && npm init -y >/dev/null 2>&1 && npm i --no-save "workerd@$version" >/dev/null 2>&1)
  fi
  (cd workerd && "../$dir/node_modules/.bin/workerd" serve config.capnp) &
  WORKERD_PID=$!
  for _ in $(seq 1 50); do
    curl -sS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && return 0
    sleep 0.2
  done
  echo "workerd $version never became ready" >&2
  exit 1
}

stop_workerd() {
  kill "$WORKERD_PID" 2>/dev/null || true
  wait "$WORKERD_PID" 2>/dev/null || true
}

pkill -f "workerd serve config.capnp" 2>/dev/null || true
rm -rf workerd/do-state
mkdir -p workerd/do-state

echo "== writing with workerd@$WRITER"
run_workerd "$WRITER"
fetch_json /kv/put; echo
stop_workerd

echo "== reading with workerd@$READER"
run_workerd "$READER"
RESULT=$(fetch_json /kv/get)
stop_workerd
echo "$RESULT"

if echo "$RESULT" | grep -q "Unable to deserialize cloned data"; then
  echo
  echo "REPRODUCED: reader workerd@$READER cannot deserialize a value written by workerd@$WRITER"
  exit 0
fi
echo
echo "no skew between $WRITER and $READER — value round-tripped; try a pair straddling a V8 format bump"
exit 2
