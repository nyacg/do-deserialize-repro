import { DurableObject } from "cloudflare:workers";

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
 * A value that exercises a spread of V8 serializer tags (object, array,
 * string, number, bigint, Map, TypedArray, Date). Format-version bumps
 * ship alongside encoding changes, so a richer value is likelier to trip
 * an older reader than a bare string.
 */
const richValue = () => ({
  note: "do-deserialize-repro",
  writtenAt: new Date(),
  big: 123456789012345678901234567890n,
  map: new Map([["k", "v"]]),
  bytes: new Uint8Array([1, 2, 3, 4]),
  nested: { arr: [1, "two", null, true] },
});

const describe = (value) =>
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
        default:
          return new Response(
            "routes: /probe /kv/put /kv/get /rpc /facet\n",
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
  },
};
