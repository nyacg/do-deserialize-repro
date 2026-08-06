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

## Abort-churn probe (2026-08-05: what production actually settled)

The first day of exported DO logs (sauna PR #5208) pinned the failure to
the **DO→facet hop** and killed the transport theories:

- Every wedged call logs `hop=in_do` — the DO method body runs.
- `withFacetRecovery` fires (`retried=true`) ~23×/day, and **23/23 retries
  against a freshly booted facet failed with the identical error**
  (`recovered=false`). The wedge survives facet recreation; only instance
  discard or eviction clears it.
- The reachability probe reads `reachable` on every episode — the DO
  answers `getMeta` over the same worker↔DO boundary while the facet hop
  fails.

So the poison is **instance-level, in-memory, specific to the facet
machinery** — and the one operation production performs on that machinery
around every wedge is `ctx.facets.abort()` (deploys and the recovery path
both call it, and #5195 independently showed it poisons hibernatable WS
delivery). The churn probe tests whether the abort is also the *trigger*:

- `/churn` — redeploy-under-traffic rounds: in-flight `slow()` calls into
  facet A, `facets.abort()` mid-flight, immediately boot facet B (new code
  id) and hammer it. `scripts/abort-churn.sh` drives it across instances
  and abort timings.
- `/stampede` — the concurrent shape (production logged two recovery
  aborts in the same second): N workers loop call → on failure abort +
  retry on the same code id (the `withFacetRecovery` shape), periodic
  deploy-style aborts, boots stretched by `bootDelayMs` so aborts land
  mid-boot.
- The 5-minute cron runs one churn round + one stampede per tick across
  six rotating instances and persists tallies in the registry —
  `/churn/stats` — so a hit survives log retention.

Results so far (2026-08-05):

- **360 sequential abort-under-traffic rounds: zero deserialize outcomes.**
  In-flight calls die with the abort reason, post-abort boots are clean.
- **~2,500 stampede iterations: zero deserialize outcomes.** But the race
  regime is real: aborts landing mid-boot produce opaque
  `internal error; reference = …` failures (not clean abort rejections),
  and >4 concurrent dynamic-worker invocations per request hit an
  undocumented Worker Loader concurrency cap.

So a bare abort/boot race does not mint the wedge at this scale, on this
build, with a trivial facet. Untested ingredients production has and this
probe does not: hibernatable WebSockets registered on the instance
(#5195's poison target), multi-MB app bundles, facet SQLite of real size,
and whatever build the wedged hosts run. The cron accumulates ~40k
outcomes/day in the meantime.

## Sauna-shaped reproduction (2026-08-05, closing the fidelity gap)

`src/sauna-shaped.js`: a structural copy of the production apps runtime
rather than a minimal probe — production wedges correlate with *real use*
("a bunch of writes, actually using the app"), so every channel real use
exercises is present:

- `SaunaSupervisor` DO mirroring `app-supervisor.ts`: invocations /
  worker_logs / meta SQLite writes bracketing every facet call,
  `withFacetRecovery` (abort + retry), context headers, redeploy path
  (facet abort + new runtime id).
- The vendored wrapper (`wrapper-source.ts`): `blockConcurrencyWhile` boot
  with DDL + a drizzle-shaped migration journal (re-runs on every
  hibernation wake), `recordInput` facet-SQLite write on every dispatch,
  verbatim `__sqlExec` returning row sets.
- The loopback entrypoints from `facet.ts`: `AppInvocationControl` as the
  facet's `env.APP_PLATFORM`, `AppPipedreamProxy` as `globalOutbound`,
  and the `AppLogTail` tail worker — every app `console.log` re-enters
  the same supervisor DO via `ingestLogs`, concurrently with dispatches.
- A handler doing meaningful work: bulk inserts, row-returning reads,
  outbound fetches, logs on every request; a 256KB pad module for
  non-trivial compiles.

Drive it: `/sauna/use?name=X&rounds=4&burst=4&redeployEvery=3`, check
`/sauna/verify?name=X`, `/sauna/stats?name=X`; the cron adds two rounds
per tick on six rotating instances (each idles ~25 min between turns, so
hibernation wakes are covered) — accumulated in `/sauna/accumulated`.

### Findings so far

**~2,400 outcomes across 20 instances under heavy concurrent use with
redeploys: zero deserialize errors — but a new failure mode:**

```
Internal error in Durable Object storage caused object to be reset;
```

Redeploy aborts racing in-flight bulk writes trip an internal error in
the DO **storage layer**, and the platform resets the instance. It
clusters hard per-instance (3 of 12 instances took 22–25 resets each;
the other 9 took zero) and the reset destroys in-memory state (the
supervisor's `codeVersion` reverts), i.e. the platform performs the
equivalent of `ctx.abort()`. Every instance recovered afterwards.

That chain — facet abort under write load → storage-layer internal error
→ per-instance failure burst → cleared by instance replacement — has
exactly the shape of the production wedge except the error string. The
missing conversion from "storage reset" to "poisoned deserialize state"
may need production's state sizes, its workerd build, or an unlucky
timing this harness hasn't hit yet; the cron keeps rolling the dice.

## What triggers it in production — eliminations (2026-08-06)

ClickHouse `app_supervisor_meta` for the apps that wedged on 2026-08-05:
`sauna-home-v2` last deployed **07-06**, `sauna-home-d2ungulk` **07-05**,
`ceo-desk` **07-04**, `expedition` **07-27** — apps that had not deployed
in weeks wedged repeatedly. So the original onset is **not** app deploys
(and earlier: not cold starts, not payload content, not concurrency, not
`facets.abort()` races at n≈10k).

Meanwhile every instrumented episode (post-#5208 DO logs, including
`meego-support` on 2026-08-06 03:56 UTC with `phase=facet_call` captured
on the db_query path) shows the same thing: the **entire facet channel**
of one DO instance dies — dispatch and `__sqlExec` both — while
`getMeta`/`listLogs` on the same instance answer normally, retries
against freshly booted facets fail 100% of the time, and the state is
in-memory (eviction or instance replacement cures it).

The hypothesis that fits everything remaining: **build skew between the
DO's workerd process and the process pool hosting Worker Loader
facets**, created when a Cloudflare fleet rollout passes under
long-lived instances. That cannot be forced from user code — it can only
be caught in the act, which is what the hammer fleet below is for. The
sharpest counter-evidence to date is also recorded honestly: sauna's
apps run in one process model and this repo's probes in the same one,
and no local pair of published builds fails this hop.

## The hammer fleet (self-driving, catches rollouts in the act)

24 sauna-shaped instances drive themselves via DO alarms — 12 at 20s
cadence, 12 at 60s — each alarm running a compact production-shaped
round (schedule tick, bulk writes, blob write/read, row reads, SSE
stream, outbound fetch, db/query, periodic redeploy) with hibernation
wakes in between. Zero-cost to watch:

```
curl $BASE/sauna/fleet?n=24        # per-instance runs / resets / hits
curl $BASE/sauna/accumulated       # cron-leg tallies
curl $BASE/churn/stats             # abort-churn tallies
curl "$BASE/sauna/hammer?fleet=24&on=0"   # teardown
```

A deserialize hit persists in the instance's own storage (`hits[]` with
timestamps) and logs `SAUNA HAMMER HIT` to Workers Logs. If a rollout
wedges any instance, the 20s cadence measures persistence and recovery
timing automatically.

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
