#!/usr/bin/env python3
"""TCP interposer for scripts/rpc-forge.sh.

Sits between the two workerd processes and rewrites the V8 format-version
byte of the first serialized payload travelling client -> peer, which is
byte-for-byte what a payload produced by a newer build looks like. The
peer's own deserializer then rejects it on the JSRPC hop.

V8's wire format is [0xFF, formatVersion, ...]. The JSRPC argument list is
serialized as a JS array, so its header is 0xFF 0x0F 0x41 ('A' = begin
array) — specific enough not to collide with capnp framing (observed at
offset 565 of the first post-CONNECT frame).
"""

import os
import socket
import sys
import threading

LISTEN_PORT = int(os.environ.get("FORGE_LISTEN_PORT", "8793"))
TARGET_PORT = int(os.environ.get("FORGE_TARGET_PORT", "8790"))
FORGE_VERSION = int(os.environ.get("FORGE_VERSION", "255"))
NEEDLE = b"\xff\x0f\x41"

# How to damage the payload; scripts/rpc-failure-modes.sh sweeps all of them
# to show which damage produces which error.
MODE = os.environ.get("MODE", "version")

state = {"forged": False, "sniffed": False}


def damage(data, offset):
    """Apply MODE to the payload starting at `offset` (the 0xFF header byte)."""
    if MODE == "version":
        return data[: offset + 1] + bytes([FORGE_VERSION]) + data[offset + 2 :]
    if MODE == "firstbyte":
        return data[:offset] + b"\x00" + data[offset + 1 :]
    if MODE == "corrupt-mid":
        j = offset + 30
        return data[:j] + bytes([data[j] ^ 0xFF]) + data[j + 1 :]
    if MODE == "truncate-tail":
        return data[: len(data) - 40]
    if MODE == "truncate-hard":
        return data[: offset + 8]
    raise SystemExit(f"unknown MODE {MODE}")


def pump(src, dst, rewrite):
    while True:
        try:
            data = src.recv(65536)
        except OSError:
            break
        if not data:
            break
        if rewrite and not state["forged"]:
            i = data.find(NEEDLE)
            if i >= 0:
                original = len(data)
                data = damage(data, i)
                state["forged"] = True
                print(
                    f"mode={MODE} applied at offset {i} "
                    f"({original}-byte frame -> {len(data)} bytes)",
                    flush=True,
                )
            elif not state["sniffed"]:
                state["sniffed"] = True
                print(f"no V8 header in first frame: {data[:64].hex()}", flush=True)
        try:
            dst.sendall(data)
        except OSError:
            break
    try:
        dst.shutdown(socket.SHUT_WR)
    except OSError:
        pass


def handle(client):
    peer = socket.create_connection(("127.0.0.1", TARGET_PORT))
    threading.Thread(target=pump, args=(client, peer, True), daemon=True).start()
    threading.Thread(target=pump, args=(peer, client, False), daemon=True).start()


listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", LISTEN_PORT))
listener.listen(8)
print(f"forging proxy {LISTEN_PORT} -> {TARGET_PORT}", flush=True)
sys.stdout.flush()

while True:
    conn, _ = listener.accept()
    handle(conn)
