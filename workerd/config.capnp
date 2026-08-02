using Workerd = import "/workerd/workerd.capnp";

# Raw workerd config for the cross-build skew repro (scripts/skew.sh).
# DO storage persists to ./do-state on disk, so a blob written by one
# workerd build can be read back by a different build — the same V8
# serializer version boundary a staged rollout creates between live
# workers. No Worker Loader here: the facet hop is wrangler/production
# only; this config exists solely to swap builds under the storage hop.

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
    (name = "disk", disk = (path = "do-state", writable = true)),
  ],
  sockets = [
    (name = "http", address = "*:8787", http = (), service = "main"),
  ],
);

const mainWorker :Workerd.Worker = (
  modules = [
    (name = "worker.js", esModule = embed "../src/worker.js"),
  ],
  # Low compat date so old reader builds can run this worker — the V8
  # serializer format is gated by the build's V8 version, not compat date,
  # so this does not weaken the repro. (Production wrangler.jsonc keeps
  # sauna's real 2026-04-17.)
  compatibilityDate = "2025-05-01",
  compatibilityFlags = ["nodejs_compat"],
  durableObjectNamespaces = [
    (className = "Supervisor", uniqueKey = "supervisor-repro", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "disk"),
  bindings = [
    (name = "SUPERVISOR", durableObjectNamespace = "Supervisor"),
  ],
);
