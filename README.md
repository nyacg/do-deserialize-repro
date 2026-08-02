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

## Findings from running this (2026-08-02)

- All four hops work under `wrangler dev` — the whole apps-runtime shape
  (DO supervisor + Worker Loader facet + RPC + storage) reproduces in one
  file.
- Storage writes are version-pinned: an Aug 2026 build writes format
  version **15** (a 2021-era version). This is why the production wedge
  never corrupts data and why alarms/facet work while RPC fails.
- Cross-build persistence round-trips across the entire public range
  tested (`1.20250502.0` ↔ `1.20260801.1`), and both `1.20260710.1`
  (pre-incident) and `1.20260801.1` accept forged versions up to 254 —
  public npm builds share serializer behavior. The producing side of the
  production skew is therefore **not in any npm-published build**: it's in
  Cloudflare's fleet builds (which run ahead of npm) and/or the RPC
  layer's own host-object versioning. Only Cloudflare can bisect that —
  see "Upstream" below.
- Forged version 255 is rejected by every build tested, with the exact
  production error, thrown from workerd's genuine storage deserializer.

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
