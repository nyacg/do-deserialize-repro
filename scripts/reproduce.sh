#!/usr/bin/env bash
# End-to-end reproduction: deploy the main worker, arm 8 self-probing DO
# instances with warm facet channels, verify a clean baseline, then make
# account config changes (deploy/delete the trigger worker) and watch the
# untouched instances start failing with the deserialize error.
set -euo pipefail

# Modes:
#   reproduce.sh          full run: deploy, arm, age 10 min, trigger cycles
#   reproduce.sh arm      deploy + arm only — leave running 30+ min (hours
#                         is better), then run `reproduce.sh trigger`
#   reproduce.sh trigger  fire config-change cycles at already-armed
#                         instances and poll for the error
#
# Observed reproduction conditions (see README): instances must hold WARM
# facet channels when the config change propagates, and reproduction
# probability grows with time since this worker's own last deploy (its own
# deploy replaces every instance, which immunizes briefly). Three waves in
# one day under aged-warm conditions; a fresh-deploy one-shot run has not
# reproduced. If `trigger` finds nothing, let the armed instances age
# longer and rerun `trigger` — every deploy in the account is a trigger.
MODE="${1:-full}"
N=8
here="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$MODE" != "trigger" ]; then
  echo "== deploying main worker"
  out=$(cd "$here" && npx wrangler deploy 2>&1) || { echo "$out"; exit 1; }
  BASE="${BASE:-$(echo "$out" | grep -om1 'https://[^ ]*workers.dev')}"
  echo "   $BASE"
  sleep 15
  echo "== arming $N instances at 20s cadence"
  for i in $(seq 1 "$N"); do
    curl -sf --max-time 30 "$BASE/sauna/hammer?name=repro-h-$i&on=1&intervalMs=20000&redeployEvery=999" > /dev/null
  done
else
  : "${BASE:?trigger mode needs BASE=https://<worker>.workers.dev}"
fi
if [ "$MODE" = "arm" ]; then
  echo "armed. Let the instances age 30+ minutes (longer is better), then:"
  echo "  BASE=$BASE bash scripts/reproduce.sh trigger"
  exit 0
fi

hits() {
  local total=0 d
  for i in $(seq 1 "$N"); do
    d=$(curl -s --max-time 20 "$BASE/sauna/stats?name=repro-h-$i" |
      python3 -c 'import json,sys; h=(json.load(sys.stdin).get("hammerStats") or {}); print(h.get("deserialize",0))' 2>/dev/null || echo 0)
    total=$((total + d))
  done
  echo "$total"
}

if [ "$MODE" = "trigger" ]; then AGE="${AGE:-0}"; else AGE="${AGE:-600}"; fi
if [ "$AGE" -gt 0 ]; then
  echo "== aging/warming ${AGE}s, then baseline (longer aging reproduces more reliably)"
  sleep "$AGE"
fi
base_hits=$(hits)
echo "   baseline deserialize outcomes: $base_hits (instances warm and clean)"

verdict() {
  local now
  now=$(hits)
  if [ "$now" -gt "$base_hits" ]; then
    echo
    echo "REPRODUCED: $((now - base_hits)) deserialize outcomes on untouched instances"
    for i in $(seq 1 "$N"); do
      curl -s --max-time 20 "$BASE/sauna/stats?name=repro-h-$i" | python3 -c '
import json,sys
r=json.load(sys.stdin); h=r.get("hammerStats") or {}
if h.get("deserialize"): print("  repro-h-'"$i"':", h["deserialize"], "hits, first:", (h.get("hits") or [{}])[0])'
    done
    for i in $(seq 1 "$N"); do curl -s "$BASE/sauna/hammer?name=repro-h-$i&on=0" > /dev/null; done
    echo "instances stopped; delete workers with:"
    echo "  npx wrangler delete --name churn-trigger-dummy --force"
    exit 0
  fi
  return 1
}

attempt() {
  echo "== trigger: $1"
  eval "$2" > /dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9; do
    sleep 20
    verdict && exit 0 || true
  done
  echo "   no wave from this attempt"
}

attempt "deploy trigger worker"   "cd '$here/trigger' && npx wrangler deploy"
attempt "delete trigger worker"   "npx wrangler delete --name churn-trigger-dummy --force"
attempt "redeploy trigger worker" "cd '$here/trigger' && npx wrangler deploy"

echo
echo "NOT REPRODUCED this session — waves are machine-dependent; rerun, or"
echo "leave the instances armed and deploy any other worker in the account."
for i in $(seq 1 "$N"); do curl -s "$BASE/sauna/hammer?name=repro-h-$i&on=0" > /dev/null; done
