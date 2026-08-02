using Workerd = import "/workerd/workerd.capnp";

# The calling side of the cross-build JSRPC skew repro
# (scripts/rpc-skew.sh). PEER is an external service reached over the
# peer process's capnp CONNECT socket, so `env.PEER.echo(...)` is a real
# cross-process JSRPC call whose arguments this build serializes and the
# peer build deserializes.

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .clientWorker),
    (
      name = "peer",
      external = (
        address = "127.0.0.1:8790",
        http = (capnpConnectHost = "rpc-peer"),
      )
    ),
  ],
  sockets = [
    (name = "http", address = "*:8791", http = (), service = "main"),
  ],
);

const clientWorker :Workerd.Worker = (
  modules = [
    (name = "rpc-skew.js", esModule = embed "../src/rpc-skew.js"),
    (name = "worker.js", esModule = embed "../src/worker.js"),
  ],
  compatibilityDate = "2025-05-01",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [
    (name = "PEER", service = "peer"),
  ],
);
