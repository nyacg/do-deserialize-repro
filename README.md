# do-deserialize-repro

Minimal reproduction of the Durable Object wedge behind sauna SN-2367:

```
Unable to deserialize cloned data due to invalid or unsupported version.
```

One plain-JS worker (`src/worker.js`, ~170 lines) mirrors every
serialization hop of the sauna apps runtime, individually labeled, plus two
scripts that reproduce the error deterministically against workerd's own
deserializer.

## The mechanism

Every JS RPC argument/return crossing a worker↔DO boundary is V8-serialized.
The wire format starts `[0xFF, formatVersion, ...]` and the deserializer
rejects any header version newer than its own build supports — that
rejection is this exact error. Within one process both sides share a build,
so it can never fire locally; it fires when **two different workerd builds
talk to each other**, which is what Cloudflare's staged runtime rollouts do
to cross-machine worker↔DO RPC (edge fleet and DO hosts update at different
times, and a long-lived DO can sit on a stale host for days).

## The hops (matching sauna's runtime)

| hop | sauna equivalent | verdict |
|---|---|---|
| `rpc_worker_to_do` | `AppSupervisor` RPC methods (pre-ADR-0030 `dispatch`/`queryDb`/`deployPrepared`) | **the vulnerable hop** — live V8 codec across machines |
| `http_worker_to_do` | WS upgrades; post-ADR-0030 everything | control group — capnp HTTP, no V8 codec, immune |
| `do_storage_kv` | DO storage / SQLite | safe — writes are **pinned** (observed: format version 15 written by an Aug 2026 build), so stale readers always succeed; data survives the wedge intact |
| `do_to_facet` | `ctx.facets.get("app")` + Worker Loader (`apps/apps/src/apps/facet.ts`) | safe from build skew — in-process, both sides same build |

`GET /probe` runs all four and returns `{hop: "ok" | "ERROR: …"}` — during a
live skew event the response pinpoints the broken hop.

## Reproduce locally (deterministic)

```
npm install
bash scripts/forge-version.sh          # the error, from workerd's own deserializer
```

The script stores a real value through DO storage, rewrites the persisted
header's version byte to 255 (byte-for-byte what a payload from a newer
build looks like), restarts workerd, and reads it back:

```
workerd/io/stored-value.c++:85: … Error: Unable to deserialize cloned data
due to invalid or unsupported version.; key = skew
```

`FORGE_VERSION=<n>` bisects a build's acceptance threshold;
`scripts/skew.sh <writer-ver> <reader-ver>` writes with one npm workerd
build and reads with another (real cross-build persistence, no forging).

## Reproduce the RPC hop (deterministic)

The storage scripts above can only swap builds under `do_storage_kv`,
whose writes are pinned and whose reader is lenient. These two run the
**vulnerable hop** instead — a real cross-process JSRPC call between two
workerd processes over a capnp CONNECT channel (`capnpConnectHost`,
`workerd/rpc-{peer,client}.capnp`), which is the transport Cloudflare uses
to deliver JSRPC between machines:

```
bash scripts/rpc-skew.sh 1.20250502.0 1.20260801.1   # two real builds, no forging
bash scripts/rpc-forge.sh                            # the production error, on the RPC hop
```

`rpc-forge.sh` interposes a TCP proxy (`scripts/rpc-forge-proxy.py`) that
rewrites the V8 format-version byte of the argument list in flight — the
JSRPC payload is a serialized JS array, header `FF 0F 41`, found at offset
565 of the first post-CONNECT frame. The caller gets, from the peer's own
deserializer:

```
{"error":"Unable to deserialize cloned data due to invalid or unsupported version."}
```

`FORGE_VERSION=<n> scripts/rpc-forge.sh [build]` bisects a build's ceiling.

## Findings from running this (2026-08-02)

- All four hops work under `wrangler dev` — the whole apps-runtime shape
  (DO supervisor + Worker Loader facet + RPC + storage) reproduces in one
  file.
- Storage writes are version-pinned: an Aug 2026 build writes format
  version **15** (a 2021-era version). This is why the production wedge
  never corrupts data and why alarms/facet work while RPC fails.
- **The RPC hop enforces a much tighter version check than storage.** The
  storage reader accepts forged versions up to 254; the JSRPC reader
  accepts only up to its build's ceiling and throws the production error
  one past it. Same error string, different strictness — which is why the
  wedge shows up on RPC and never on stored data.
- **The ceiling moved during the incident window.** Bisected by forging
  version 16 onto the RPC hop:

  | build | accepts format version 16 |
  |---|---|
  | `1.20260601.1`, `1.20260615.1`, `1.20260617.1` | no — production error |
  | `1.20260619.1`, `1.20260623.1`, `1.20260630.1`, `1.20260801.1` | yes |

  So V8's serializer ceiling went 15 → 16 between **1.20260617.1** and
  **1.20260619.1**, and sauna's onset was ~2026-06-30 — the fleet rolling
  out a post-06-19 build. Any peer still on a pre-06-19 build rejects a
  version-16 payload with exactly this error.
- Both directions still round-trip between real npm builds
  (`rpc-skew.sh 1.20250502.0 1.20260801.1`), because npm readers accept 16
  but every npm **writer** still emits 15. The producing side of the
  production skew is therefore a fleet build emitting 16 — ahead of npm,
  so only Cloudflare can name it. See "Upstream" below.

## Reproduce in production (the real trigger)

`npm run deploy`, then watch. The worker probes all four hops every 5
minutes via cron (`scheduled`) and `console.error`s failing hops into
Workers Logs. During a staged runtime rollout (sauna hit it 2026-07-14,
-16, -20, -23), expect:

```
probe failures {"rpc_worker_to_do":"ERROR: Unable to deserialize cloned data …"}
```

while `http_worker_to_do` stays `ok` — the observation behind sauna's
ADR-0030 (move the worker↔DO boundary to `stub.fetch` HTTP).

## Upstream ask (Cloudflare)

A long-lived DO pinned to a host on the other side of a rollout stays
unreachable over JS RPC for days (its V8 payload versions disagree with its
peers'), while HTTP `stub.fetch` to the same DO keeps working. Ask: pin the
RPC serialization version across staged rollouts the way stored values
already are, or version-negotiate the RPC channel. This repo is the
minimal testcase: deploy it, run a staged rollout, watch
`rpc_worker_to_do` fail while `http_worker_to_do` passes.

Concretely: `scripts/rpc-forge.sh` shows the failure mode on a single
build, and the bisect above shows the reader ceiling rising 15 → 16 at
`1.20260619.1`. The question for Cloudflare is which fleet build began
**emitting** version 16, and whether it was rolled out to hosts whose
JSRPC peers were still pre-`1.20260619.1` — that pairing is sufficient to
produce every symptom seen (RPC dead, `stub.fetch` fine, stored data
intact, per-DO and durable across redeploys).
