#!/usr/bin/env bash
# Deterministic repro of the production error ON THE PRODUCTION HOP: a real
# cross-process JSRPC call whose V8 format-version byte is rewritten in
# flight (scripts/rpc-forge-proxy.py) to look like a payload from a newer
# build. The peer's own deserializer rejects it and the caller sees:
#
#   {"error":"Unable to deserialize cloned data due to invalid or unsupported version."}
#
# This is what scripts/forge-version.sh does for DO storage, moved onto the
# hop that actually wedged production (worker->DO JSRPC). Needed because no
# two npm-published builds disagree (see scripts/rpc-skew.sh), so the
# version skew has to be injected.
#
# Usage: scripts/rpc-forge.sh [workerd-version]   (default 1.20260801.1)
#        FORGE_VERSION=<n> scripts/rpc-forge.sh   (bisect the threshold)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-1.20260801.1}"
PROXY_PORT=8793
CLIENT_PORT=8791

pkill -f "workerd serve rpc-" 2>/dev/null || true
pkill -f "rpc-forge-proxy.py" 2>/dev/null || true
sleep 1

DIR=".workerd-cache/$VERSION"
if [ ! -x "$DIR/node_modules/.bin/workerd" ]; then
  mkdir -p "$DIR"
  (cd "$DIR" && npm init -y >/dev/null 2>&1 && npm i --no-save "workerd@$VERSION" >/dev/null 2>&1)
fi
WORKERD="$PWD/$DIR/node_modules/.bin/workerd"

cd workerd
"$WORKERD" serve rpc-peer.capnp > ../rpc-peer.log 2>&1 &
PEER_PID=$!
cd ..

python3 scripts/rpc-forge-proxy.py > rpc-proxy.log 2>&1 &
PROXY_PID=$!

cd workerd
"$WORKERD" serve rpc-client.capnp --external-addr "peer=127.0.0.1:$PROXY_PORT" > ../rpc-client.log 2>&1 &
CLIENT_PID=$!
cd ..

cleanup() { kill "$PEER_PID" "$PROXY_PID" "$CLIENT_PID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 60); do
  nc -z 127.0.0.1 "$CLIENT_PORT" 2>/dev/null && break
  sleep 0.25
done

if grep -q "Fatal uncaught" ../rpc-peer.log rpc-peer.log 2>/dev/null; then
  echo "peer failed to start (stale process on :8790?) — see rpc-peer.log" >&2
  exit 1
fi

echo "== workerd@$VERSION, JSRPC argument forged to format version ${FORGE_VERSION:-255}"
RESULT=$(curl -sS -m 20 "http://127.0.0.1:$CLIENT_PORT/echo" || echo '{"error":"request failed"}')
echo "  proxy: $(grep -m1 forged rpc-proxy.log || echo 'no payload forged')"
echo "  /echo: $RESULT"

if echo "$RESULT" | grep -q "Unable to deserialize cloned data"; then
  echo
  echo "REPRODUCED — workerd@$VERSION rejected the forged JSRPC payload on the worker->peer hop"
  exit 0
fi
echo
echo "not reproduced — inspect rpc-peer.log / rpc-client.log"
exit 2
