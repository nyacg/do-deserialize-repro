using Workerd = import "/workerd/workerd.capnp";

# The "DO host" side of the cross-build JSRPC skew repro
# (scripts/rpc-skew.sh). `capnpConnectHost` turns a CONNECT request into a
# Cap'n Proto RPC connection carrying JSRPC events — the same transport
# Cloudflare uses between machines, so the V8 payload is deserialized by
# THIS process's build after being serialized by the client's build.

const config :Workerd.Config = (
  services = [(name = "main", worker = .peerWorker)],
  sockets = [
    (name = "rpc", address = "*:8790", http = (capnpConnectHost = "rpc-peer"), service = "main"),
  ],
);

const peerWorker :Workerd.Worker = (
  modules = [
    (name = "rpc-skew.js", esModule = embed "../src/rpc-skew.js"),
    (name = "worker.js", esModule = embed "../src/worker.js"),
  ],
  # Kept low so old builds can run the module; the V8 serializer format is
  # gated by the build's V8 version, not the compat date.
  compatibilityDate = "2025-05-01",
  compatibilityFlags = ["nodejs_compat"],
);
