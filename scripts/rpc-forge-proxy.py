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

state = {"forged": False, "sniffed": False}


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
                data = data[: i + 1] + bytes([FORGE_VERSION]) + data[i + 2 :]
                state["forged"] = True
                print(
                    f"forged V8 format version 15 -> {FORGE_VERSION} "
                    f"(offset {i} of a {len(data)}-byte frame)",
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
