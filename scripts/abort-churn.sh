#!/usr/bin/env bash
# Drive the /churn route: redeploy-under-traffic rounds across many DO
# instances, sweeping the abort-vs-in-flight timing. The production wedge
# signature is any "Unable to deserialize cloned data" outcome; a hit is
# left in place (no discard) so /churn/verify can confirm the wedge
# persists on that instance the way production wedges do.
set -euo pipefail

BASE="${BASE:?set BASE=https://<worker>.workers.dev}"
INSTANCES="${INSTANCES:-8}"
SWEEPS="${SWEEPS:-3}"
ROUNDS="${ROUNDS:-5}"

total_deserialize=0
for sweep in $(seq 1 "$SWEEPS"); do
  # Vary how far into the in-flight calls the abort lands.
  for hold in 20 60 200; do
    for i in $(seq 1 "$INSTANCES"); do
      name="churn-${sweep}-${hold}-${i}"
      out=$(curl -sf "$BASE/churn?name=${name}&rounds=${ROUNDS}&inflight=8&holdMs=${hold}") || {
        echo "${name}: request failed"
        continue
      }
      hits=$(echo "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["deserialize"])')
      if [ "$hits" != "0" ]; then
        echo "HIT ${name}: ${out}"
        echo "verify: $(curl -s "$BASE/churn/verify?name=${name}")"
        total_deserialize=$((total_deserialize + hits))
      fi
    done
    echo "sweep ${sweep} holdMs=${hold}: done"
  done
done

echo
if [ "$total_deserialize" -gt 0 ]; then
  echo "REPRODUCED: ${total_deserialize} deserialize outcomes — check the HIT lines above"
else
  rounds_total=$((SWEEPS * 3 * INSTANCES * ROUNDS))
  echo "no deserialize outcomes in ${rounds_total} abort-under-traffic rounds"
fi
