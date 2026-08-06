# do-deserialize-repro

Reproduction of a Durable Object failure mode on Cloudflare Workers:
**deploying or deleting any worker in an account breaks the Worker Loader
facet channels of *other, untouched* workers' active DO instances.** Every
facet call on an affected instance — RPC methods and `fetch` alike — then
fails with

```
Unable to deserialize cloned data due to invalid or unsupported version.
```

while the DO itself stays healthy (its own RPC methods, SQLite, and alarms
all keep working). The wedge is in-memory and per-instance: it survives
`ctx.facets.abort()` + re-`get()` (a **fresh facet fails identically**),
and clears only when the DO instance is evicted or replaced. Severity per
wave ranges from one failed round to 15–30 minutes stuck.

In production (Wordware's app platform, ~900 DO-hosted apps) this fires
multiple times daily and wedges whichever apps hold warm facet channels at
the moment any account deploy propagates — i.e. exactly the apps users are
actively using.

## Reproduce it

Requires only `wrangler` authenticated against a test account with Worker
Loader access. One command:

```
npm install
bash scripts/reproduce.sh
```

The script deploys the main worker, arms 8 self-driving DO instances that
run production-shaped facet traffic every 20s, ages them, verifies a
clean baseline, then deploys/deletes/redeploys the trivial trigger worker
in `trigger/` — a fetch handler that does nothing — polling for the error
after each config change. A hit prints:

```
REPRODUCED: N deserialize outcomes on untouched instances
  repro-h-3: 8 hits, first: {"at": "...", "outcome": "ERROR: Unable to deserialize cloned data due to invalid or unsupported version."}
```

**Reproduction conditions — read before judging a negative run.** All
three observed waves hit instances that (a) held warm facet channels at
the moment the config change propagated and (b) had aged since their own
worker's last deploy (28 minutes to 16 hours; the worker's own deploy
replaces every instance and briefly immunizes). A fresh one-shot run
directly after first deploy has NOT reproduced, and waves are
machine-sparse (3–13 of 24 instances per wave). The reliable protocol is
the two-step:

```
bash scripts/reproduce.sh arm       # deploy + arm, then leave running
# ... 30+ minutes later (hours or overnight is better) ...
BASE=<printed url> bash scripts/reproduce.sh trigger
```

Ordinary account activity works as a trigger too: with instances armed,
any deploy of any worker in the account can produce the wave.

Manual equivalent:

```
npx wrangler deploy                                   # main worker
BASE=https://do-deserialize-repro.<subdomain>.workers.dev
for i in 1 2 3 4 5 6 7 8; do
  curl "$BASE/sauna/hammer?name=repro-h-$i&on=1&intervalMs=20000&redeployEvery=999"
done
sleep 90; curl "$BASE/sauna/stats?name=repro-h-1"     # hammerStats: all ok
npx wrangler deploy -c trigger/wrangler.jsonc         # ← the trigger
sleep 60; for i in 1 2 3 4 5 6 7 8; do
  curl -s "$BASE/sauna/stats?name=repro-h-$i" | grep -o '"deserialize":[0-9]*'
done
```

Waves are machine-dependent (not every instance is hit every time); if a
deploy produces nothing in ~3 minutes, `npx wrangler delete --name
churn-trigger-dummy --force` — deletions produced the strongest observed
wave — or redeploy and check again. Teardown:
`curl "$BASE/sauna/hammer?fleet=0&name=repro-h-$i&on=0"` per instance and
`npx wrangler delete` both workers.

## Evidence: verified waves and controls

All times 2026-08-06 UTC, one account, 24 instrumented instances
(`src/sauna-shaped.js`, results persisted in each instance's SQLite):

| time | account action | result |
|---|---|---|
| 05:06:08 | `wrangler delete` of a sibling worker | 13/24 instances wedged within seconds; onsets staggered 05:06→05:21; each stuck 15–30 min across 3–6 probe rounds; fresh-facet retries failed every time |
| 21:27:49 | deploy of `trigger/` dummy | 12 instances wedged, mid-flight rounds included |
| 21:40:39 | redeploy of the dummy — **zero other actions in flight** | 3 instances wedged, two of them on idle 5-minute cadence untouched for hours |
| — | control: no account config change | 16 h / ~50,000 outcomes, zero errors |
| — | control: cadence/config changes to the repro's own worker just after its own deploy | zero errors (own-worker deploys replace instances wholesale) |

Also reproduced along the way (see [FINDINGS.md](FINDINGS.md)):
`facets.abort()` racing in-flight facet writes intermittently yields
`Internal error in Durable Object storage caused object to be reset` —
per-instance bursts of 22–25, possibly the same defect surfacing at a
different layer.

## What the reproduction worker is

`src/sauna-shaped.js` is a structural copy of a production app platform:
a supervisor DO that boots a Worker Loader facet with `ctx.exports`
loopback bindings (`env` service binding, `globalOutbound`, a tail
worker), runs dispatches and SQL through it (row sets incl. BLOBs, SSE
streams, schedule ticks), writes SQLite on both sides of every call, and
self-drives via DO alarms. A `facetMode` switch strips boot-config pieces
(`bare` / `no-tails` / `no-outbound` / `no-platform`) for bisection; a
`no-outbound` instance has been hit, so `globalOutbound` is not required.
The channel bisection is otherwise incomplete.

## Production impact (summary; full trail in FINDINGS.md)

- ~5 wedge episodes/day across 15+ apps for 5+ weeks (onset ~2026-06-30),
  each 503ing an app for minutes to over an hour.
- Fully instrumented episodes show: DO reachable (answers other RPC on
  the same boundary during the wedge), throw at the facet call, recovery
  abort + retry against a freshly created facet failed **23 of 23 times**.
- Wedged apps had not deployed in weeks — the trigger is account-level,
  not app-level, matching this repro.
- Wedge timestamps cluster on quarter-hour boundaries: scheduled-task
  alarms are the facet traffic that first notices the poison.

## Questions for Cloudflare

1. What does account config propagation invalidate in the dynamic-loader
   / facet pipeline while warm channels still reference the previous
   state? The error suggests a serialization version/brand-table mismatch
   read by V8's deserializer.
2. Why does a **freshly created facet** on the same instance inherit the
   poison (retries failed 23/23 in production, reproducibly here), and is
   there any in-band cure short of `ctx.abort()` on the instance?
3. Can the failure be surfaced as a distinguishable error (or healed
   transparently), rather than the generic deserialize message?

We know facets and Worker Loader are experimental; this is offered as a
worked reproduction, not a complaint about stability guarantees.

## Also in this repo

- `scripts/rpc-forge.sh`, `scripts/rpc-skew.sh`, `scripts/forge-version.sh`
  — deterministic local demonstrations (npm workerd builds) of the same
  error from V8's own deserializer, including a bisect showing the JSRPC
  reader's format-version ceiling moved 15→16 between `1.20260617.1` and
  `1.20260619.1`, and `scripts/rpc-failure-modes.sh` showing which payload
  damage yields which error.
- [FINDINGS.md](FINDINGS.md) — the full chronological investigation,
  including every eliminated hypothesis (build skew between published
  builds, cold starts at n=2,452, payload content, concurrency, abort
  races at n≈10k) and the production telemetry that guided it.
