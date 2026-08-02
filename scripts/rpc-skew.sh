#!/usr/bin/env bash
# Cross-build repro of the PRODUCTION hop: two workerd processes on two
# different builds exchange a JSRPC call over a capnp CONNECT channel
# (workerd/rpc-{peer,client}.capnp, `capnpConnectHost`), which is how
# Cloudflare delivers JSRPC between machines. Arguments are serialized by
# the caller's build and deserialized by the peer's, so a format-version
# disagreement surfaces as:
#   "Unable to deserialize cloned data due to invalid or unsupported version."
#
# Unlike scripts/skew.sh (DO storage, writes version-pinned) this exercises
# the live V8 codec on the hop that actually wedged production.
#
# Usage: scripts/rpc-skew.sh <peer-workerd-version> <client-workerd-version>
# e.g.:  scripts/rpc-skew.sh 1.20250502.0 1.20260801.1
#
# /echo tests client->peer serialization, /emit tests peer->client.
set -euo pipefail
cd "$(dirname "$0")/.."

PEER_VER="${1:?peer workerd version required}"
CLIENT_VER="${2:?client workerd version required}"
PEER_PORT=8790
CLIENT_PORT=8791

install_workerd() {
  local version="$1"
  local dir=".workerd-cache/$version"
  if [ ! -x "$dir/node_modules/.bin/workerd" ]; then
    mkdir -p "$dir"
    (cd "$dir" && npm init -y >/dev/null 2>&1 && npm i --no-save "workerd@$version" >/dev/null 2>&1)
  fi
  echo "$PWD/$dir/node_modules/.bin/workerd"
}

wait_for_port() {
  for _ in $(seq 1 60); do
    nc -z 127.0.0.1 "$1" 2>/dev/null && return 0
    sleep 0.25
  done
  echo "port $1 never opened" >&2
  return 1
}

pkill -f "workerd serve rpc-" 2>/dev/null || true

PEER_BIN=$(install_workerd "$PEER_VER")
CLIENT_BIN=$(install_workerd "$CLIENT_VER")

cd workerd
"$PEER_BIN" serve rpc-peer.capnp > ../rpc-peer.log 2>&1 &
PEER_PID=$!
"$CLIENT_BIN" serve rpc-client.capnp > ../rpc-client.log 2>&1 &
CLIENT_PID=$!
cd ..

cleanup() { kill "$PEER_PID" "$CLIENT_PID" 2>/dev/null || true; }
trap cleanup EXIT

wait_for_port "$PEER_PORT"
wait_for_port "$CLIENT_PORT"

echo "== peer workerd@$PEER_VER  <->  client workerd@$CLIENT_VER"
ECHO=$(curl -sS -m 20 "http://127.0.0.1:$CLIENT_PORT/echo" || echo '{"error":"request failed"}')
EMIT=$(curl -sS -m 20 "http://127.0.0.1:$CLIENT_PORT/emit" || echo '{"error":"request failed"}')
echo "  /echo (client->peer): $ECHO"
echo "  /emit (peer->client): $EMIT"

if printf '%s%s' "$ECHO" "$EMIT" | grep -q "Unable to deserialize cloned data"; then
  echo
  echo "REPRODUCED: JSRPC between workerd@$PEER_VER and workerd@$CLIENT_VER hits the production error"
  exit 0
fi

echo
echo "no skew between $PEER_VER and $CLIENT_VER — both directions round-tripped"
exit 2
