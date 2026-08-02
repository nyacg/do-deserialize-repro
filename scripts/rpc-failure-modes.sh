#!/usr/bin/env bash
# What does each kind of payload damage look like on the JSRPC hop?
#
# Motivation: production sees "Unable to deserialize cloned data due to
# invalid or unsupported version." many times a day, on apps in active use,
# on days with one or two runtime rollouts — far too often for staged build
# skew. This sweep shows the error string is NOT specific to a version
# mismatch: any bytes that don't parse as a V8 header produce it.
#
# Usage: scripts/rpc-failure-modes.sh [workerd-version]
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-1.20260801.1}"
CLIENT_PORT=8791

DIR=".workerd-cache/$VERSION"
if [ ! -x "$DIR/node_modules/.bin/workerd" ]; then
  mkdir -p "$DIR"
  (cd "$DIR" && npm init -y >/dev/null 2>&1 && npm i --no-save "workerd@$VERSION" >/dev/null 2>&1)
fi
WORKERD="$PWD/$DIR/node_modules/.bin/workerd"

for MODE in version firstbyte corrupt-mid truncate-tail truncate-hard; do
  pkill -f "workerd serve rpc-" 2>/dev/null || true
  pkill -f "rpc-forge-proxy.py" 2>/dev/null || true
  sleep 1

  (cd workerd && "$WORKERD" serve rpc-peer.capnp > ../rpc-peer.log 2>&1 &)
  # Subshell so bash does not job-track it and announce the pkill above.
  ( MODE="$MODE" python3 scripts/rpc-forge-proxy.py > rpc-proxy.log 2>&1 & )
  sleep 1
  (cd workerd && "$WORKERD" serve rpc-client.capnp --external-addr peer=127.0.0.1:8793 > ../rpc-client.log 2>&1 &)

  for _ in $(seq 1 60); do
    nc -z 127.0.0.1 "$CLIENT_PORT" 2>/dev/null && break
    sleep 0.25
  done

  # curl exits non-zero on the modes that hang the connection; pipefail must
  # not abort the sweep before the remaining modes run.
  RESULT=$(curl -sS -m 20 "http://127.0.0.1:$CLIENT_PORT/echo" 2>&1 | head -c 110 || true)
  printf '%-14s -> %s\n' "$MODE" "$RESULT"
done

pkill -f "workerd serve rpc-" 2>/dev/null || true
pkill -f "rpc-forge-proxy.py" 2>/dev/null || true
