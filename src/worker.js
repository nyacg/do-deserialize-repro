import { DurableObject } from "cloudflare:workers";
import { runSaunaUse, saunaRoutes } from "./sauna-shaped.js";

/** ctx.exports only sees top-level worker exports, so the sauna-shaped
 * supervisor and its loopback entrypoints must be re-exported here. */
export {
  AppInvocationControl,
  AppLogTail,
  AppPipedreamProxy,
  SaunaSupervisor,
} from "./sauna-shaped.js";

/**
 * Minimal stand-in for sauna's app facet (packages/apps-runtime
 * wrapper-source.ts App class): loaded via Worker Loader, attached as a
 * DO facet, answering a JS RPC method — the do_to_facet hop.
 */
const FACET_SOURCE = `
import { DurableObject } from "cloudflare:workers";
export class App extends DurableObject {
  async roundtrip(value) {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
    return { echoed: value, from: "facet" };
  }
}
export default { fetch() { return new Response("app ok"); } };
`;

/**
 * Facet source for the abort-churn probe. codeId is baked into the module
 * so each churn round boots a genuinely different worker, the way a sauna
 * redeploy gives the facet a new runtimeId. slow() keeps an RPC in flight
 * so facets.abort() can land mid-call.
 */
const churnFacetSource = (codeId) => `
import { DurableObject } from "cloudflare:workers";
const CODE_ID = ${JSON.stringify(codeId)};
export class App extends DurableObject {
  async roundtrip(value) {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
    return { echoed: value, from: "facet", codeId: CODE_ID };
  }
  async slow(ms, value) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { echoed: value, from: "facet-slow", codeId: CODE_ID };
  }
}
export default { fetch() { return new Response("app ok " + CODE_ID); } };
`;

/**
 * A value that exercises a spread of V8 serializer tags (object, array,
 * string, number, bigint, Map, TypedArray, Date). Format-version bumps
 * ship alongside encoding changes, so a richer value is likelier to trip
 * an older reader than a bare string.
 */
export const richValue = () => ({
  note: "do-deserialize-repro",
  writtenAt: new Date(),
  big: 123456789012345678901234567890n,
  map: new Map([["k", "v"]]),
  bytes: new Uint8Array([1, 2, 3, 4]),
  nested: { arr: [1, "two", null, true] },
});

export const describe = (value) =>
  JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return `${v}n`;
    if (v instanceof Map) return Object.fromEntries(v);
    if (v instanceof Uint8Array) return `Uint8Array(${v.length})`;
    return v;
  });

/**
 * richValue() carries a bigint (plus Map/TypedArray), which Response.json()
 * refuses to encode — describe() is the only safe way to render a hop's
 * return value as a response body.
 */
const describedResponse = (value) =>
  new Response(describe(value), {
    headers: { "content-type": "application/json" },
  });

export class Supervisor extends DurableObject {
  /**
   * hop rpc_worker_to_do — args/return are V8-serialized across the
   * worker<->DO boundary. This is the hop that wedged sauna production
   * (app-supervisor RPC methods) when the two sides ran different
   * workerd builds during a staged rollout.
   */
  async echo(value) {
    return { echoed: value, from: "supervisor-rpc" };
  }

  /**
   * hop do_storage_kv — storage.put writes the value V8-serialized to
   * disk; storage.get deserializes it. The only hop where WE control
   * which workerd build wrote and which reads (scripts/skew.sh), which
   * is exactly what a staged rollout does to the live RPC hops. Same
   * codec, same version check, same error.
   */
  async kvPut(key) {
    await this.ctx.storage.put(key, richValue());
    return { ok: true };
  }

  async kvGet(key) {
    const value = await this.ctx.storage.get(key);
    if (value === undefined) {
      throw new Error(`no value at ${key} — run /kv/put first`);
    }
    return { ok: true, value: describe(value) };
  }

  /**
   * hop do_to_facet — mirrors sauna's apps/apps/src/apps/facet.ts:
   * Worker Loader isolate attached as a DO facet, called over JS RPC.
   * In-process, so build skew can't occur live; included so the
   * production probe covers every hop the real runtime has.
   */
  async facetRoundtrip() {
    if (!this.env.LOADER || !this.ctx.facets) {
      throw new Error("unsupported: no LOADER binding / ctx.facets here");
    }
    const facet = this.ctx.facets.get("app", () => {
      const loaded = this.env.LOADER.get("repro-app", async () => ({
        compatibilityDate: "2026-04-17",
        mainModule: "app.js",
        modules: { "app.js": FACET_SOURCE },
      }));
      return { class: loaded.getDurableObjectClass("App") };
    });
    return await facet.roundtrip(richValue());
  }

  /**
   * hop http_worker_to_do — the control group: stub.fetch crosses the
   * same boundary as rpc_worker_to_do but as capnp HTTP with no V8
   * codec. During a live skew event this hop keeps working while the
   * RPC hop throws — the observation behind sauna's ADR-0030.
   */
  async fetch() {
    return Response.json({ ok: true, from: "supervisor-http" });
  }

  /**
   * Boot (or reuse) the "app" facet from a codeId-specific worker.
   * bootDelayMs stretches the loader callback the way a real app bundle's
   * compile does, so a concurrent abort can land mid-boot.
   */
  facetFor(codeId, bootDelayMs = 0) {
    return this.ctx.facets.get("app", () => {
      const loaded = this.env.LOADER.get(`churn-${codeId}`, async () => {
        if (bootDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, bootDelayMs));
        }
        return {
          compatibilityDate: "2026-04-17",
          mainModule: "app.js",
          modules: { "app.js": churnFacetSource(codeId) },
        };
      });
      return { class: loaded.getDurableObjectClass("App") };
    });
  }

  /**
   * One redeploy-under-traffic round — the shape sauna production wedges
   * follow (2026-08-05, first day of exported DO logs: wedges hit apps in
   * active use, the recovery abort fires ~23x/day, and 23/23 retries
   * against a fresh facet failed with the same deserialize error, so the
   * poison is instance-level and facets.abort() is the prime suspect):
   *
   *   1. start in-flight calls into facet A,
   *   2. facets.abort() mid-flight — what both a redeploy and
   *      withFacetRecovery do,
   *   3. immediately boot facet B (new code id, like a redeploy) and
   *      hammer it.
   *
   * Any post-abort "Unable to deserialize cloned data" outcome is the
   * production wedge signature reproduced on demand.
   */
  async abortChurn(opts = {}) {
    const inflight = opts.inflight ?? 8;
    const holdMs = opts.holdMs ?? 60;
    const postAbortCalls = opts.postAbortCalls ?? 10;
    this.churnEpoch = (this.churnEpoch ?? 0) + 1;
    const codeId = `${Date.now()}-${this.churnEpoch}`;

    const before = this.facetFor(`pre-${codeId}`);
    const pending = Array.from({ length: inflight }, () =>
      before
        .slow(holdMs, richValue())
        .then(() => "ok")
        .catch((err) => `ERROR: ${err instanceof Error ? err.message : err}`),
    );
    /** Let the calls reach the facet before pulling the rug. */
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, Math.floor(holdMs / 2))),
    );
    try {
      this.ctx.facets.abort("app", "churn: redeploy under traffic");
    } catch (err) {
      return { abortError: String(err?.message ?? err) };
    }

    const postAbort = [];
    for (let i = 0; i < postAbortCalls; i++) {
      try {
        await this.facetFor(`post-${codeId}`).roundtrip(richValue());
        postAbort.push("ok");
      } catch (err) {
        postAbort.push(`ERROR: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { inflight: await Promise.all(pending), postAbort };
  }

  /**
   * The production instant, concurrently: at 2026-08-05 17:08:39 UTC two
   * recovery aborts landed in the same second — concurrent dispatches each
   * running withFacetRecovery, aborts racing each other and racing the
   * facet reboot. N workers each loop call → on failure abort+recall (the
   * withFacetRecovery shape), with periodic deploy-style aborts thrown in,
   * boots stretched by bootDelayMs so aborts land mid-boot.
   */
  async stampede(opts = {}) {
    const workers = opts.workers ?? 8;
    const iters = opts.iters ?? 12;
    const bootDelayMs = opts.bootDelayMs ?? 20;
    this.churnEpoch = (this.churnEpoch ?? 0) + 1;
    const epoch = this.churnEpoch;

    const outcomes = [];
    const attempt = async (codeId) => {
      try {
        await this.facetFor(codeId, bootDelayMs).slow(5, richValue());
        return "ok";
      } catch (err) {
        return `ERROR: ${err instanceof Error ? err.message : err}`;
      }
    };
    const abortQuietly = (reason) => {
      try {
        this.ctx.facets.abort("app", reason);
      } catch {
        /** No facet running — the race we are here to provoke. */
      }
    };

    /**
     * Two code ids per stampede, flipped like a deploy A->B->A. Recovery
     * retries reuse the failing id, matching withFacetRecovery (only a
     * deploy changes the loader id in production) — and staying under the
     * 4-concurrent-dynamic-workers-per-request loader cap.
     */
    await Promise.all(
      Array.from({ length: workers }, (_, w) =>
        (async () => {
          for (let i = 0; i < iters; i++) {
            const codeId = `st-${epoch}-${i % 2 === 0 ? "a" : "b"}`;
            const first = await attempt(codeId);
            outcomes.push(first);
            if (first !== "ok") {
              /** withFacetRecovery: abort, then retry on a fresh boot. */
              abortQuietly("stampede recovery abort");
              outcomes.push(`retry: ${await attempt(codeId)}`);
            }
            if ((w + i) % 3 === 0) {
              abortQuietly("stampede deploy abort");
            }
          }
        })(),
      ),
    );
    return { outcomes };
  }

  /** The "probe" instance doubles as the churn registry, so a hit survives
   * Workers Logs retention. */
  async recordChurn(summary) {
    const stats = (await this.ctx.storage.get("churn-stats")) ?? {
      runs: 0,
      outcomes: 0,
      deserialize: 0,
      hits: [],
    };
    stats.runs += 1;
    stats.outcomes += summary.outcomes;
    stats.deserialize += summary.deserialize;
    if (summary.hit) {
      stats.hits = [...stats.hits.slice(-19), summary.hit];
    }
    await this.ctx.storage.put("churn-stats", stats);
    return stats;
  }

  async churnStats() {
    return (await this.ctx.storage.get("churn-stats")) ?? null;
  }

  async recordSauna(summary) {
    const stats = (await this.ctx.storage.get("sauna-stats")) ?? {
      runs: 0,
      outcomes: 0,
      deserialize: 0,
      hits: [],
    };
    stats.runs += 1;
    stats.outcomes += summary.outcomes;
    stats.deserialize += summary.deserialize;
    if (summary.hit) {
      stats.hits = [...stats.hits.slice(-19), summary.hit];
    }
    await this.ctx.storage.put("sauna-stats", stats);
    return stats;
  }

  async saunaStats() {
    return (await this.ctx.storage.get("sauna-stats")) ?? null;
  }
}

const HOPS = {
  http_worker_to_do: async (stub) => {
    const res = await stub.fetch("https://supervisor.internal/echo");
    return await res.json();
  },
  rpc_worker_to_do: async (stub) => await stub.echo(richValue()),
  do_storage_kv: async (stub) => {
    await stub.kvPut("probe");
    return await stub.kvGet("probe");
  },
  do_to_facet: async (stub) => await stub.facetRoundtrip(),
};

const runProbe = async (env) => {
  const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName("probe"));
  const results = {};
  for (const [hop, run] of Object.entries(HOPS)) {
    try {
      await run(stub);
      results[hop] = "ok";
    } catch (err) {
      results[hop] = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return results;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName("probe"));
    try {
      if (url.pathname.startsWith("/sauna/")) {
        const handled = await saunaRoutes(url, env);
        if (handled) {
          return handled;
        }
      }
      switch (url.pathname) {
        case "/probe":
          return Response.json(await runProbe(env));
        case "/kv/put":
          return Response.json(await stub.kvPut("skew"));
        case "/kv/get":
          return Response.json(await stub.kvGet("skew"));
        case "/rpc":
          return describedResponse(await stub.echo(richValue()));
        case "/facet":
          return describedResponse(await stub.facetRoundtrip());
        case "/churn": {
          /**
           * Runs on its own instance name so churn aborts never touch the
           * cron probe's "probe" instance.
           */
          const name = url.searchParams.get("name") ?? "churn-1";
          const rounds = Number(url.searchParams.get("rounds") ?? 5);
          const opts = {
            inflight: Number(url.searchParams.get("inflight") ?? 8),
            holdMs: Number(url.searchParams.get("holdMs") ?? 60),
            postAbortCalls: Number(url.searchParams.get("postAbortCalls") ?? 10),
          };
          const churnStub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(name));
          const tally = {};
          let deserialize = 0;
          for (let i = 0; i < rounds; i++) {
            const round = await churnStub.abortChurn(opts);
            const outcomes = [
              ...(round.inflight ?? []),
              ...(round.postAbort ?? []),
              ...(round.abortError ? [`ABORT: ${round.abortError}`] : []),
            ];
            for (const outcome of outcomes) {
              tally[outcome] = (tally[outcome] ?? 0) + 1;
              if (outcome.includes("Unable to deserialize cloned data")) {
                deserialize += 1;
              }
            }
          }
          return Response.json({ name, rounds, ...opts, deserialize, tally });
        }
        case "/stampede": {
          const name = url.searchParams.get("name") ?? "churn-1";
          const rounds = Number(url.searchParams.get("rounds") ?? 3);
          const opts = {
            workers: Number(url.searchParams.get("workers") ?? 8),
            iters: Number(url.searchParams.get("iters") ?? 12),
            bootDelayMs: Number(url.searchParams.get("bootDelayMs") ?? 20),
          };
          const churnStub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(name));
          const tally = {};
          let deserialize = 0;
          for (let i = 0; i < rounds; i++) {
            const { outcomes } = await churnStub.stampede(opts);
            for (const outcome of outcomes) {
              tally[outcome] = (tally[outcome] ?? 0) + 1;
              if (outcome.includes("Unable to deserialize cloned data")) {
                deserialize += 1;
              }
            }
          }
          return Response.json({ name, rounds, ...opts, deserialize, tally });
        }
        case "/churn/stats":
          return Response.json(await stub.churnStats());
        case "/sauna/accumulated":
          return Response.json(await stub.saunaStats());
        case "/churn/verify": {
          /** Is this instance's facet path currently wedged? */
          const name = url.searchParams.get("name") ?? "churn-1";
          const churnStub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(name));
          try {
            await churnStub.facetRoundtrip();
            return Response.json({ name, wedged: false });
          } catch (err) {
            return Response.json(
              { name, wedged: true, error: String(err?.message ?? err) },
              { status: 503 },
            );
          }
        }
        default:
          return new Response(
            "routes: /probe /kv/put /kv/get /rpc /facet /churn /stampede /churn/stats /churn/verify\n",
            { status: 404 },
          );
      }
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  },

  /**
   * Production rollout detector: probes every hop on a cron tick and
   * console.errors failing hops, so a live skew event lands in Workers
   * Logs labeled with the hop that broke.
   */
  async scheduled(_event, env) {
    const results = await runProbe(env);
    const failing = Object.entries(results).filter(([, r]) => r !== "ok");
    if (failing.length > 0) {
      console.error("probe failures", JSON.stringify(Object.fromEntries(failing)));
    } else {
      console.log("probe ok", JSON.stringify(results));
    }

    /**
     * Abort-churn accumulation: one churn round + one stampede per tick,
     * rotating across six instances so each also cycles through idle
     * windows between its turns. ~40k outcomes/day; results persist in the
     * registry so a hit outlives log retention.
     */
    const name = `cron-churn-${Math.floor(Date.now() / 300_000) % 6}`;
    const churnStub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(name));
    const outcomes = [];
    try {
      const round = await churnStub.abortChurn({
        inflight: 6,
        holdMs: 40,
        postAbortCalls: 6,
      });
      outcomes.push(...(round.inflight ?? []), ...(round.postAbort ?? []));
      const st = await churnStub.stampede({
        workers: 4,
        iters: 8,
        bootDelayMs: 20,
      });
      outcomes.push(...st.outcomes);
    } catch (err) {
      outcomes.push(`CRON ERROR: ${err instanceof Error ? err.message : err}`);
    }
    const deser = outcomes.filter((o) =>
      o.includes("Unable to deserialize cloned data"),
    );
    const registry = env.SUPERVISOR.get(env.SUPERVISOR.idFromName("probe"));
    await registry.recordChurn({
      outcomes: outcomes.length,
      deserialize: deser.length,
      hit: deser.length
        ? { at: new Date().toISOString(), name, samples: deser.slice(0, 3) }
        : undefined,
    });
    if (deser.length > 0) {
      console.error("CHURN HIT", JSON.stringify({ name, samples: deser.slice(0, 3) }));
    }

    /**
     * Sauna-shaped accumulation: two agent-usage rounds per tick against a
     * rotating app instance (each instance idles ~25 min between turns, so
     * hibernation wakes are exercised too), with a redeploy every 4th
     * round — the full production channel set under realistic use.
     */
    const saunaName = `sauna-cron-${Math.floor(Date.now() / 300_000) % 6}`;
    const saunaOutcomes = [];
    for (let round = 0; round < 2; round++) {
      try {
        saunaOutcomes.push(
          ...(await runSaunaUse(env, {
            name: saunaName,
            burst: 3,
            redeployEvery: 4,
            round: Math.floor(Date.now() / 300_000) + round,
          })),
        );
      } catch (err) {
        saunaOutcomes.push(
          `CRON ERROR: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    const saunaDeser = saunaOutcomes.filter((o) =>
      o.includes("Unable to deserialize cloned data"),
    );
    await registry.recordSauna({
      outcomes: saunaOutcomes.length,
      deserialize: saunaDeser.length,
      hit: saunaDeser.length
        ? {
            at: new Date().toISOString(),
            name: saunaName,
            samples: saunaDeser.slice(0, 3),
          }
        : undefined,
    });
    if (saunaDeser.length > 0) {
      console.error(
        "SAUNA HIT",
        JSON.stringify({ name: saunaName, samples: saunaDeser.slice(0, 3) }),
      );
    }
  },
};
