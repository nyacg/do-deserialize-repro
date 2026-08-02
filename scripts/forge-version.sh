#!/usr/bin/env bash
# Deterministic repro of the production error using workerd's OWN
# deserializer. V8's serialized wire format is [0xFF, formatVersion, ...]
# and the deserializer rejects any header version newer than its build
# supports. We store a real value through DO storage, bump the persisted
# header's version byte by one (byte-for-byte what a payload written by a
# newer build looks like), restart workerd, and read it back:
#
#   "Unable to deserialize cloned data due to invalid or unsupported version."
#
# Usage: scripts/forge-version.sh [workerd-version]   (default 1.20260801.1)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-1.20260801.1}"
PORT=8787

run_workerd() {
  local dir=".workerd-cache/$VERSION"
  if [ ! -x "$dir/node_modules/.bin/workerd" ]; then
    mkdir -p "$dir"
    (cd "$dir" && npm init -y >/dev/null 2>&1 && npm i --no-save "workerd@$VERSION" >/dev/null 2>&1)
  fi
  (cd workerd && "../$dir/node_modules/.bin/workerd" serve config.capnp >> workerd.log 2>&1) &
  WORKERD_PID=$!
  for _ in $(seq 1 50); do
    curl -sS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && return 0
    sleep 0.2
  done
  echo "workerd $VERSION never became ready" >&2
  exit 1
}

stop_workerd() {
  kill "$WORKERD_PID" 2>/dev/null || true
  wait "$WORKERD_PID" 2>/dev/null || true
}

rm -rf workerd/do-state workerd/workerd.log
mkdir -p workerd/do-state

echo "== 1. write a value through DO storage (workerd@$VERSION)"
run_workerd
curl -sS "http://127.0.0.1:$PORT/kv/put"; echo
stop_workerd

echo "== 2. forge the persisted V8 format-version byte (as if written by a newer build)"
# Writes are pinned (observed: version 15) but a reader accepts anything up
# to its own build's max, so the forged version must exceed that max.
# FORGE_VERSION lets you bisect the exact acceptance threshold of a build.
python3 - <<'EOF'
import glob, os, sqlite3

forged = int(os.environ.get("FORGE_VERSION", "255"))
for path in glob.glob("workerd/do-state/**/*.sqlite", recursive=True):
    con = sqlite3.connect(path)
    tables = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_cf_KV'")]
    if not tables:
        con.close()
        continue
    for (key, value) in con.execute("SELECT key, value FROM _cf_KV"):
        blob = bytearray(value)
        assert blob[0] == 0xFF, f"unexpected header tag {blob[0]:#x}"
        print(f"  {path} key={key!r}: format version {blob[1]} -> {forged}")
        blob[1] = forged
        con.execute("UPDATE _cf_KV SET value = ? WHERE key = ?", (bytes(blob), key))
    con.commit()
    con.close()
EOF

echo "== 3. read it back through workerd's own deserializer"
run_workerd
RESULT=$(curl -sS "http://127.0.0.1:$PORT/kv/get")
stop_workerd
echo "$RESULT"

# The app-visible response is workerd's tunneled "internal error"; the real
# rejection lands in workerd's log (workerd/io/stored-value.c++), same V8
# ValueDeserializer check that throws on the RPC hop in production.
if grep -q "Unable to deserialize cloned data" workerd/workerd.log 2>/dev/null ||
   echo "$RESULT" | grep -q "Unable to deserialize cloned data"; then
  echo
  echo "REPRODUCED — workerd@$VERSION rejected the forged newer-version payload:"
  grep -o "Unable to deserialize cloned data[^;]*" workerd/workerd.log | head -1
  exit 0
fi
echo
echo "not reproduced — inspect the result above and workerd/workerd.log"
exit 2
