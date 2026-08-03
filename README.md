# do-deserialize-repro

Minimal reproduction of the Durable Object wedge behind sauna SN-2367:

```
Unable to deserialize cloned data due to invalid or unsupported version.
```

One plain-JS worker (`src/worker.js`, ~170 lines) mirrors every
serialization hop of the sauna apps runtime, individually labeled, plus
scripts that reproduce the error deterministically against workerd's own
deserializer — on DO storage (`scripts/forge-version.sh`) and on the hop
that actually wedged production (`scripts/rpc-forge.sh`).

Live probe: https://do-deserialize-repro.sauna-dev.workers.dev/probe —
deployed in the sauna Cloudflare account, cron-probing every hop every 5
minutes. Delete with `npx wrangler delete --name do-deserialize-repro`.

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

## The error string is not specific to version skew

`scripts/rpc-failure-modes.sh` damages the payload five different ways on
the same hop and shows what each one looks like:

| damage | result |
|---|---|
| version byte bumped past the ceiling | `Unable to deserialize cloned data due to invalid or unsupported version.` |
| header tag `0xFF` zeroed | **same message** |
| one byte flipped mid-payload | no error — silently corrupted data (`do-deserialize-rero`) |
| payload truncated at the tail | `Network connection lost.` |
| payload cut just after the header | request hangs until the caller times out |
| payload over 32MiB | `Serialized RPC arguments or return values are limited to 32MiB…` |

So the production message means only "the bytes where a V8 payload should
start do not parse as a V8 header". A newer-build writer is one way to get
there; a buffer read at the wrong offset, or bytes that were never a
serialized value, produce it identically. Note also that mid-payload
corruption is **not** caught — it returns wrong data with no error.

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
- **Frequency in production contradicts a rollout-only cause.** Apps wedge
  several times a day, in active use, on days with one or two runtime
  rollouts. Staged skew cannot fire that often — see the failure-mode
  table above for what else yields the identical message.
- Both directions still round-trip between real npm builds
  (`rpc-skew.sh 1.20250502.0 1.20260801.1`), because npm readers accept 16
  but every npm **writer** still emits 15. The producing side of the
  production skew is therefore a fleet build emitting 16 — ahead of npm,
  so only Cloudflare can name it. See "Upstream" below.

## What production actually shows (Honeycomb, 2026-08-03)

`apps-production`, warn logs with `hop` set, last 7 days:

- **161 events / 34 episodes / 15 distinct apps** — roughly five wedge
  episodes a day, every day. All of them `label=db_query`, body
  `db/query hit deserialize-version error`.
- **Every one is `hop=route_to_do`. Zero `hop=do_to_facet`.** The facet
  call and `ctx.facets.get()` both sit inside `withFacetRecovery`, so a
  throw there would log `do_to_facet` — the failure is on the worker↔DO
  JSRPC boundary, not the facet hop.
- Spread across **17 apps-worker script versions** in 7 days, i.e. every
  deployed version. Two rollouts a day cannot explain five episodes a day
  across every version — this is continuous background behaviour, not
  rollout skew.
- Every episode sits inside an agent session trace: these are agent-driven
  `db/query` tool calls, which is why it correlates with apps being used.
- Episodes are bursts of 2–6 retries seconds apart, then the app recovers
  on its own.

## Cold-start probe (the current bet)

`src/coldstart.js` + `wrangler.coldstart.jsonc`, deployed separately as
`do-coldstart-probe`. The `/probe` worker above hits one DO every five
minutes, so it is never cold — it cannot catch a wedge that fires on the
first RPC into an idle DO.

This one runs 82 supervisor-shaped DOs (own SQLite + a Worker Loader facet
with persisted state) in dwell cohorts of 15m / 1h / 6h / 24h. A one-minute
cron probes only the DOs whose dwell has elapsed, one RPC each, and writes
every outcome to a registry DO's SQLite so a hit survives log retention.

```
npx wrangler deploy -c wrangler.coldstart.jsonc
curl https://do-coldstart-probe.sauna-dev.workers.dev/stats
```

Each result carries `coldBoot`, measured idle minutes, the hop that failed
(`route_to_do` vs `do_to_facet` — the same split `withFacetRecovery` makes)
and whether the error was the deserialize one, so edge blips and the real
wedge stay distinguishable. Throughput is ~2 cold starts/minute (~3k/day).

## Hypotheses eliminated

Each was tested on the real cross-process JSRPC hop and did **not**
reproduce the error:

| hypothesis | result |
|---|---|
| build skew between published builds | round-trips across `1.20250502.0` ↔ `1.20260801.1`, both directions |
| oversized payload | 32MiB limit has its own explicit message |
| lone surrogates / NUL / invalid pairs in row strings | all round-trip |
| 50-way concurrent RPC on one connection | 200/200 calls clean |

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
