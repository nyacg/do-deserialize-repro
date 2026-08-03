import { DurableObject } from "cloudflare:workers";

/**
 * Cold-start wedge probe.
 *
 * Production evidence (2026-08-03): the deserialize wedge fires on the first
 * RPC into an AppSupervisor DO that has been idle since its last scheduled
 * run — 14 of 28 wedged apps have lastErrorAt on an exact minute boundary,
 * 12 of those on a quarter-hour, matching scheduled_tasks_schedules firings.
 * The throw lands at the caller (hop=route_to_do) with no app-side log, and
 * the app stays wedged until redeployed (28/28, median 69 min).
 *
 * The /probe worker in this repo cannot catch that: one DO, hit every five
 * minutes, never cold. This worker reproduces the shape instead — a fleet of
 * supervisor-like DOs (SQLite + Worker Loader facet with persisted state),
 * each left idle for its cohort's dwell, then hit with exactly one RPC while
 * cold. Results go to a registry DO's SQLite so a hit survives log retention.
 */

const FACET_SOURCE = `
import { DurableObject } from "cloudflare:workers";
export class App extends DurableObject {
  async append(note) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS probe_rows (at INTEGER, note TEXT)",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO probe_rows (at, note) VALUES (?, ?)",
      Date.now(),
      note,
    );
    const rows = this.ctx.storage.sql
      .exec("SELECT at, note FROM probe_rows ORDER BY at DESC LIMIT 5")
      .toArray();
    return { rows, rowCount: rows.length };
  }
}
export default { fetch() { return new Response("app ok"); } };
`;

/**
 * Dwell is what the production trigger varies: scheduled tasks run hourly or
 * daily, so the DO has been evicted for that long when the call lands. Short
 * cohorts buy trial count, long cohorts buy fidelity.
 */
const COHORTS = [
  { dwellMinutes: 15, count: 40 },
  { dwellMinutes: 60, count: 24 },
  { dwellMinutes: 360, count: 12 },
  { dwellMinutes: 1440, count: 6 },
];

/** Cap per cron tick so one tick can't exhaust the subrequest budget. */
const MAX_PROBES_PER_TICK = 40;

const isDeserializeError = (err) =>
  err instanceof Error &&
  err.message.includes("Unable to deserialize cloned data");

const errorMessage = (err) =>
  err instanceof Error ? err.message : String(err);

/** Registry of probe DOs plus the durable result log. */
export class Registry extends DurableObject {
  #sql() {
    return this.ctx.storage.sql;
  }

  #init() {
    this.#sql().exec(
      "CREATE TABLE IF NOT EXISTS probes (name TEXT PRIMARY KEY, dwellMinutes INTEGER, nextDueAt INTEGER)",
    );
    /** Added after first deploy; throws once the column exists. */
    try {
      this.#sql().exec("ALTER TABLE probes ADD COLUMN lastProbeAt INTEGER");
    } catch {
      // column already present
    }
    this.#sql().exec(
      `CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER, name TEXT, dwellMinutes INTEGER,
        idleMinutes INTEGER, coldBoot INTEGER, ok INTEGER,
        hop TEXT, deserializeError INTEGER, error TEXT
      )`,
    );
  }

  async seed() {
    this.#init();
    const now = Date.now();
    let created = 0;
    for (const { dwellMinutes, count } of COHORTS) {
      for (let i = 0; i < count; i++) {
        const name = `dwell${dwellMinutes}-${i}`;
        const [existing] = this.#sql()
          .exec("SELECT name FROM probes WHERE name = ?", name)
          .toArray();
        if (existing) {
          continue;
        }
        /**
         * Stagger first-due times across the dwell window so a cohort's
         * probes don't all land on the same tick forever after.
         */
        const offset = Math.floor((dwellMinutes * 60_000 * i) / count);
        this.#sql().exec(
          "INSERT INTO probes (name, dwellMinutes, nextDueAt) VALUES (?, ?, ?)",
          name,
          dwellMinutes,
          now + offset,
        );
        created++;
      }
    }
    return { created, total: this.#counts().probes };
  }

  async due(limit) {
    this.#init();
    return this.#sql()
      .exec(
        "SELECT name, dwellMinutes, nextDueAt, lastProbeAt FROM probes WHERE nextDueAt <= ? ORDER BY nextDueAt ASC LIMIT ?",
        Date.now(),
        limit,
      )
      .toArray();
  }

  async record(result) {
    this.#init();
    this.#sql().exec(
      `INSERT INTO results
        (at, name, dwellMinutes, idleMinutes, coldBoot, ok, hop, deserializeError, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      result.at,
      result.name,
      result.dwellMinutes,
      result.idleMinutes,
      result.coldBoot ? 1 : 0,
      result.ok ? 1 : 0,
      result.hop ?? null,
      result.deserializeError ? 1 : 0,
      result.error ?? null,
    );
    this.#sql().exec(
      "UPDATE probes SET nextDueAt = ?, lastProbeAt = ? WHERE name = ?",
      result.at + result.dwellMinutes * 60_000,
      result.at,
      result.name,
    );
  }

  #counts() {
    const [probes] = this.#sql()
      .exec("SELECT COUNT(*) AS n FROM probes")
      .toArray();
    return { probes: probes?.n ?? 0 };
  }

  async stats() {
    this.#init();
    return {
      probes: this.#counts().probes,
      byDwell: this.#sql()
        .exec(
          `SELECT dwellMinutes,
                  COUNT(*) AS calls,
                  SUM(coldBoot) AS coldBoots,
                  SUM(1 - ok) AS failures,
                  SUM(deserializeError) AS deserializeErrors
             FROM results GROUP BY dwellMinutes ORDER BY dwellMinutes`,
        )
        .toArray(),
      recentFailures: this.#sql()
        .exec(
          "SELECT at, name, dwellMinutes, idleMinutes, coldBoot, hop, error FROM results WHERE ok = 0 ORDER BY id DESC LIMIT 20",
        )
        .toArray(),
    };
  }
}

/** One supervisor-shaped app: own SQLite, own Worker Loader facet. */
export class ColdProbe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    /** Unset on a fresh instance, so the first call after eviction sees 0. */
    this.callsSinceBoot = 0;
  }

  /**
   * Mirrors AppSupervisor#queryDbInner: read own meta from SQLite, resolve
   * the facet, call it. The facet call is wrapped so a throw there is
   * reported as hop=do_to_facet instead of propagating — the same split
   * sauna's withFacetRecovery makes, so a hit tells us which side broke.
   */
  async probe() {
    const coldBoot = this.callsSinceBoot === 0;
    this.callsSinceBoot++;

    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (k, v) VALUES ('lastProbe', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      String(Date.now()),
    );

    try {
      const facet = this.ctx.facets.get("app", () => {
        const loaded = this.env.LOADER.get("cold-probe-app", async () => ({
          compatibilityDate: "2026-04-17",
          mainModule: "app.js",
          modules: { "app.js": FACET_SOURCE },
        }));
        return { class: loaded.getDurableObjectClass("App") };
      });
      const result = await facet.append(`probe at ${Date.now()}`);
      return { coldBoot, ok: true, rowCount: result.rowCount };
    } catch (err) {
      return {
        coldBoot,
        ok: false,
        hop: "do_to_facet",
        deserializeError: isDeserializeError(err),
        error: errorMessage(err),
      };
    }
  }
}

const registry = (env) =>
  env.REGISTRY.get(env.REGISTRY.idFromName("registry"));

/**
 * One cold call into one probe DO. A throw here crossed the worker->DO
 * boundary, which is the hop production fails on (route_to_do).
 */
const runProbe = async (env, entry) => {
  const at = Date.now();
  /** Null on a probe's first-ever call — there is no prior call to measure from. */
  const idleMinutes = entry.lastProbeAt
    ? Math.round((at - entry.lastProbeAt) / 60_000)
    : null;
  const stub = env.PROBE.get(env.PROBE.idFromName(entry.name));
  try {
    const res = await stub.probe();
    return {
      at,
      name: entry.name,
      dwellMinutes: entry.dwellMinutes,
      idleMinutes,
      coldBoot: res.coldBoot,
      ok: res.ok,
      hop: res.hop,
      deserializeError: res.deserializeError,
      error: res.error,
    };
  } catch (err) {
    return {
      at,
      name: entry.name,
      dwellMinutes: entry.dwellMinutes,
      idleMinutes,
      coldBoot: null,
      ok: false,
      hop: "route_to_do",
      deserializeError: isDeserializeError(err),
      error: errorMessage(err),
    };
  }
};

const tick = async (env) => {
  const reg = registry(env);
  await reg.seed();
  const entries = await reg.due(MAX_PROBES_PER_TICK);
  const results = await Promise.all(entries.map((e) => runProbe(env, e)));
  for (const result of results) {
    await reg.record(result);
  }
  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    console.error("cold-start probe failures", JSON.stringify(failures));
  }
  return { probed: results.length, failures: failures.length };
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/stats":
          return Response.json(await registry(env).stats());
        case "/seed":
          return Response.json(await registry(env).seed());
        case "/tick":
          return Response.json(await tick(env));
        default:
          return new Response("routes: /stats /seed /tick\n", { status: 404 });
      }
    } catch (err) {
      return Response.json({ error: errorMessage(err) }, { status: 500 });
    }
  },

  async scheduled(_event, env) {
    const summary = await tick(env);
    console.log("cold-start tick", JSON.stringify(summary));
  },
};
