import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

/**
 * Sauna-shaped reproduction: a faithful structural copy of the production
 * apps runtime (apps/apps + packages/apps-runtime), not a minimal probe.
 * Production evidence (2026-08-05) says the wedge hits apps under real use
 * — "a bunch of writes, actually using the app" — so this mirrors every
 * channel real use exercises:
 *
 *   worker --RPC--> SaunaSupervisor --facets--> App wrapper (Worker Loader)
 *                        ^   ^                        |
 *                        |   +--- finalizeInvocation --+ (env.APP_PLATFORM
 *                        |          via ctx.exports.AppInvocationControl)
 *                        +---- ingestLogs <-- AppLogTail tail worker
 *                                    (every console.log in the app)
 *
 * plus globalOutbound (AppPipedreamProxy), blockConcurrencyWhile boot with
 * DDL + a drizzle-shaped migration journal, a facet SQLite write on every
 * dispatch (recordInput — invocationId changes per call), supervisor
 * SQLite writes bracketing every facet call, and __sqlExec returning real
 * row sets. Strip pieces out once it reproduces.
 */

const DESERIALIZE_NEEDLE = "Unable to deserialize cloned data";
const COMPATIBILITY_DATE = "2026-04-17";
const CONTEXT_HEADERS = {
  appId: "x-sauna-app-id",
  deployedAt: "x-sauna-deployed-at",
  deployedCodeId: "x-sauna-deployed-code-id",
  invocationId: "x-sauna-invocation-id",
  dispatchKind: "x-sauna-dispatch-kind",
  session: "x-sauna-session",
};

/* ──────────────────── facet modules (vendored from apps-runtime) ─────────────────── */

/** Verbatim from WRAPPER_INPUT_SOURCE: a facet SQLite write on every
 * dispatch, because invocationId makes the input JSON unique per call. */
const INPUT_SOURCE = `export const INTERNAL_DDL = [
  "CREATE TABLE IF NOT EXISTS __sauna_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
];

export function recordInput(app, input) {
  app.__lastInput = input;
  const json = JSON.stringify(input);
  if (app.__lastInputJson === json) return;
  app.ctx.storage.sql.exec(
    "INSERT OR REPLACE INTO __sauna_meta (k, v) VALUES ('input', ?)",
    json,
  );
  app.__lastInputJson = json;
}

export function loadInput(app) {
  if (app.__lastInput) return app.__lastInput;
  try {
    const rows = app.ctx.storage.sql
      .exec("SELECT v FROM __sauna_meta WHERE k = 'input'")
      .toArray();
    if (rows.length === 0) return null;
    const parsed = JSON.parse(rows[0].v);
    app.__lastInput = parsed;
    app.__lastInputJson = rows[0].v;
    return parsed;
  } catch (_) {
    return null;
  }
}
`;

/** buildEnv/buildCtx from WRAPPER_ENV_SOURCE, minus the websocket helpers
 * (the wedged production apps in question do not use sockets). */
const ENV_SOURCE = `export function buildEnv(app) {
  const sqlStorage = app.ctx.storage.sql;
  return {
    sql: {
      query: (s, params) => {
        const cursor = sqlStorage.exec(s, ...(params || []));
        return cursor.toArray();
      },
      exec: (s, params) => {
        const cursor = sqlStorage.exec(s, ...(params || []));
        cursor.toArray();
        return {
          rowsRead: cursor.rowsRead,
          rowsWritten: cursor.rowsWritten,
        };
      },
      raw: (s, params) => {
        const cursor = sqlStorage.exec(s, ...(params || []));
        const rows = [...cursor.raw()];
        return { columns: cursor.columnNames, rows };
      },
    },
  };
}

export function buildCtx(app, input) {
  return {
    waitUntil: app.ctx.waitUntil.bind(app.ctx),
    appId: input.appId,
    deployedAt: input.deployedAt,
    deployedCodeId: input.deployedCodeId,
    session: input.session === undefined ? null : input.session,
    invocationId: input.invocationId,
  };
}
`;

/** Drizzle-shaped: a journal table consulted on every boot, pending
 * statements applied and journaled. Re-runs on every hibernation wake. */
const MIGRATIONS_SOURCE = `const MIGRATIONS = [
  "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, amount REAL NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_events_kind_at ON events (kind, at)",
];

export async function applyMigrations(storage) {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER NOT NULL)",
  );
  const done = storage.sql
    .exec("SELECT COUNT(*) AS n FROM __drizzle_migrations")
    .toArray()[0].n;
  for (let i = done; i < MIGRATIONS.length; i++) {
    storage.sql.exec(MIGRATIONS[i]);
    storage.sql.exec(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      "m" + i,
      Date.now(),
    );
  }
}
`;

/**
 * A user handler doing meaningful work: bulk writes, row-returning reads,
 * console.log on every request (drives the tail -> ingestLogs channel),
 * and an outbound fetch (drives globalOutbound).
 */
const HANDLER_SOURCE = `import { PAD } from "./pad.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    console.log("[app] " + request.method + " " + url.pathname);
    if (url.pathname === "/api/items" && request.method === "POST") {
      const body = await request.json();
      env.sql.exec(
        "INSERT INTO items (label, amount, created_at) VALUES (?, ?, ?)",
        [body.label, body.amount, Date.now()],
      );
      const rows = env.sql.query("SELECT COUNT(*) AS n FROM items");
      return Response.json({ ok: true, count: rows[0].n });
    }
    if (url.pathname === "/api/items") {
      const rows = env.sql.query(
        "SELECT id, label, amount, created_at FROM items ORDER BY id DESC LIMIT 50",
      );
      return Response.json({ items: rows });
    }
    if (url.pathname === "/api/bulk" && request.method === "POST") {
      const body = await request.json();
      const n = body.n || 40;
      for (let i = 0; i < n; i++) {
        env.sql.exec(
          "INSERT INTO events (kind, payload, at) VALUES (?, ?, ?)",
          ["bulk", JSON.stringify({ i: i, blob: "x".repeat(200) }), Date.now()],
        );
      }
      const agg = env.sql.query(
        "SELECT kind, COUNT(*) AS n, MAX(at) AS latest FROM events GROUP BY kind",
      );
      console.log("[app] bulk wrote " + n + " events");
      return Response.json({ ok: true, agg: agg });
    }
    if (url.pathname === "/api/out") {
      const res = await fetch("https://example.com/ping");
      return Response.json({ ok: true, upstream: res.status });
    }
    return Response.json({ ok: true, pad: PAD.length });
  },
};
`;

/** Wrapper App class — vendored from wrapper-source.ts minus the websocket
 * runtime module. Boot, recordInput, dispatch, and __sqlExec are verbatim. */
const WRAPPER_SOURCE = `import { DurableObject } from "cloudflare:workers";
import handler from "./handler.js";
import { buildCtx, buildEnv } from "./env.js";
import { INTERNAL_DDL, loadInput, recordInput } from "./input.js";
import { applyMigrations } from "./migrations.js";

const CONTEXT_HEADERS = {
  appId: "x-sauna-app-id",
  deployedAt: "x-sauna-deployed-at",
  deployedCodeId: "x-sauna-deployed-code-id",
  invocationId: "x-sauna-invocation-id",
  dispatchKind: "x-sauna-dispatch-kind",
  session: "x-sauna-session",
};

const __requiredHeader = (request, name) => {
  const value = request.headers.get(name);
  if (!value) {
    throw new Error("missing app dispatch context header: " + name);
  }
  return value;
};

const __inputFromRequest = (request) => {
  const deployedAt = Number(__requiredHeader(request, CONTEXT_HEADERS.deployedAt));
  const sessionHeader = request.headers.get(CONTEXT_HEADERS.session);
  let session = null;
  if (sessionHeader !== null) {
    try {
      session = JSON.parse(sessionHeader);
    } catch (_) {
      session = null;
    }
  }
  return {
    appId: __requiredHeader(request, CONTEXT_HEADERS.appId),
    deployedAt: deployedAt,
    deployedCodeId: __requiredHeader(request, CONTEXT_HEADERS.deployedCodeId),
    invocationId: __requiredHeader(request, CONTEXT_HEADERS.invocationId),
    session: session,
  };
};

const __stripContextHeaders = (request) => {
  const headers = new Headers(request.headers);
  for (const name of Object.values(CONTEXT_HEADERS)) {
    headers.delete(name);
  }
  return new Request(request, { headers: headers });
};

export class App extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.__bindings = env;
    this.__lastInput = null;
    this.__lastInputJson = null;
    this.__bootPromise = this.ctx.blockConcurrencyWhile(async () => {
      try {
        for (const stmt of INTERNAL_DDL) {
          this.ctx.storage.sql.exec(stmt);
        }
        await applyMigrations(this.ctx.storage);
      } catch (err) {
        console.error("[sauna:apps] boot failed:", err);
        throw err;
      }
    });
    try {
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair("__sauna_ping", "__sauna_pong"),
      );
    } catch (_) {
      // keepalive unavailable in this runtime; non-fatal
    }
  }

  async __bootIfNeeded() {
    await this.__bootPromise;
  }

  async fetch(request) {
    const input = __inputFromRequest(request);
    if (request.headers.get(CONTEXT_HEADERS.dispatchKind) === "schedule") {
      await this.__bootIfNeeded();
      recordInput(this, input);
      return new Response(null, { status: 204 });
    }
    return this.__dispatch(__stripContextHeaders(request), input);
  }

  async __dispatch(request, input) {
    await this.__bootIfNeeded();
    recordInput(this, input);
    if (typeof handler.fetch !== "function") {
      return new Response("handler does not export fetch", { status: 501 });
    }
    return handler.fetch(request, buildEnv(this), buildCtx(this, input));
  }

  async __sqlExec(stmt, params, maxRows) {
    await this.__bootIfNeeded();
    const cursor = this.ctx.storage.sql.exec(stmt, ...(params || []));
    let rows;
    if (typeof maxRows === "number" && maxRows >= 0) {
      rows = [];
      for (const row of cursor) {
        rows.push(row);
        if (rows.length > maxRows) break;
      }
    } else {
      rows = cursor.toArray();
    }
    return {
      rows: rows,
      rowsRead: cursor.rowsRead,
      rowsWritten: cursor.rowsWritten,
    };
  }
}

export default {
  fetch() {
    return new Response("not the entry", { status: 404 });
  },
};
`;

/** ~256KB inert module: real bundles are multi-module and non-trivial to
 * compile, which widens the facet boot window. */
const PAD_SOURCE = `export const PAD = ${JSON.stringify("x".repeat(262_144))};`;

const buildModules = () => ({
  "wrapper.js": WRAPPER_SOURCE,
  "handler.js": HANDLER_SOURCE,
  "env.js": ENV_SOURCE,
  "input.js": INPUT_SOURCE,
  "migrations.js": MIGRATIONS_SOURCE,
  "pad.js": PAD_SOURCE,
});

/* ──────────────────── loopback entrypoints (vendored from gateway/) ─────────────────── */

/** Facet env.APP_PLATFORM — RPC from app code back into the supervisor. */
export class AppInvocationControl extends WorkerEntrypoint {
  async finalizeInvocation(input) {
    const { appId } = this.ctx.props ?? {};
    if (!appId) {
      return;
    }
    try {
      const stub = this.env.SAUNA_SUP.get(this.env.SAUNA_SUP.idFromName(appId));
      await stub.finalizeInvocation(input);
    } catch (err) {
      console.warn(
        "finalizeInvocation failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Tail worker attached to the facet: every console.log in app code arrives
 * here asynchronously and is forwarded into the SAME supervisor DO over
 * RPC — the re-entrant channel real use exercises constantly.
 */
export class AppLogTail extends WorkerEntrypoint {
  async tail(events) {
    const { appId } = this.ctx.props ?? {};
    if (!appId || !events || events.length === 0) {
      return;
    }
    const flat = [];
    for (const event of events) {
      const at = event.eventTimestamp ?? Date.now();
      for (const log of event.logs ?? []) {
        flat.push({
          at: log.timestamp ?? at,
          level: String(log.level ?? "log"),
          message: Array.isArray(log.message)
            ? log.message.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" ")
            : String(log.message),
        });
      }
      for (const exception of event.exceptions ?? []) {
        flat.push({
          at: exception.timestamp ?? at,
          level: "error",
          message: `${exception.name ?? "Error"}: ${exception.message ?? ""}`,
        });
      }
    }
    if (flat.length === 0) {
      return;
    }
    try {
      const stub = this.env.SAUNA_SUP.get(this.env.SAUNA_SUP.idFromName(appId));
      this.ctx.waitUntil(
        stub.ingestLogs(flat).catch((err) => {
          console.warn(
            "ingest failed",
            err instanceof Error ? err.message : String(err),
          );
        }),
      );
    } catch (err) {
      console.warn(
        "ingest failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/** globalOutbound for the facet — all app fetch() calls land here. */
export class AppPipedreamProxy extends WorkerEntrypoint {
  async fetch(_request) {
    return Response.json({ proxied: true });
  }
}

/* ──────────────────── the supervisor (mirrors app-supervisor.ts) ─────────────────── */

const isDeserializeVersionError = (error) => {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return false;
  }
  return (
    typeof error.message === "string" &&
    error.message.includes(DESERIALIZE_NEEDLE)
  );
};

/** withFacetRecovery, verbatim shape: abort + retry once on the version error. */
const withFacetRecovery = async (abortFacet, call) => {
  try {
    return await call();
  } catch (err) {
    if (!isDeserializeVersionError(err)) {
      throw err;
    }
    abortFacet("deserialize-version-error");
    return await call();
  }
};

export class SaunaSupervisor extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.deployedAt = Date.now();
    this.codeVersion = 1;
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS invocations (id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, route TEXT, ok INTEGER NOT NULL, error_message TEXT, duration_ms INTEGER)",
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS worker_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL)",
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
      );
    });
  }

  getFacet(appId) {
    const exportsAny = this.ctx.exports;
    const runtimeId = `${appId}-v${this.codeVersion}`;
    return this.ctx.facets.get("app", async () => {
      const platformEnv = {
        APP_PLATFORM: exportsAny.AppInvocationControl({
          props: { userId: "repro-user", appId },
        }),
      };
      const loaded = this.env.LOADER.get(runtimeId, async () => ({
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
        mainModule: "wrapper.js",
        modules: buildModules(),
        env: platformEnv,
        globalOutbound: exportsAny.AppPipedreamProxy({
          props: {
            userId: "repro-user",
            appId,
            organizationId: "repro-org",
            accounts: [],
            connections: [],
          },
        }),
        tails: [
          exportsAny.AppLogTail({ props: { userId: "repro-user", appId } }),
        ],
      }));
      return { class: loaded.getDurableObjectClass("App") };
    });
  }

  abortAppFacet(reason) {
    try {
      this.ctx.facets.abort("app", reason);
    } catch (_err) {
      /** No facet running. */
    }
  }

  /** Redeploy: abort the facet, bump the runtime id — production's deploy shape. */
  async redeploy(appId) {
    this.abortAppFacet("redeploy");
    this.codeVersion += 1;
    await this.getFacet(appId).fetch(
      this.#contextRequest(appId, "GET", "/", null, "http"),
    );
    return { codeVersion: this.codeVersion };
  }

  #contextRequest(appId, method, path, body, kind) {
    const invocationId = crypto.randomUUID();
    const headers = new Headers();
    headers.set(CONTEXT_HEADERS.appId, appId);
    headers.set(CONTEXT_HEADERS.deployedAt, String(this.deployedAt));
    headers.set(CONTEXT_HEADERS.deployedCodeId, `code-v${this.codeVersion}`);
    headers.set(CONTEXT_HEADERS.invocationId, invocationId);
    headers.set(CONTEXT_HEADERS.dispatchKind, kind);
    headers.set(CONTEXT_HEADERS.session, JSON.stringify(null));
    if (body) {
      headers.set("content-type", "application/json");
    }
    const request = new Request(`https://${appId}.repro.internal${path}`, {
      method,
      headers,
      body: body ?? undefined,
    });
    request.__invocationId = invocationId;
    return request;
  }

  async dispatch(input) {
    const startedAt = Date.now();
    const request = this.#contextRequest(
      input.appId,
      input.method,
      input.path,
      input.body ? JSON.stringify(input.body) : null,
      "http",
    );
    const invocationId = request.__invocationId;
    this.ctx.storage.sql.exec(
      "INSERT INTO invocations (id, at, kind, route, ok) VALUES (?, ?, ?, ?, 0)",
      invocationId,
      startedAt,
      "http",
      input.path,
    );
    let response;
    let errorMessage = null;
    try {
      const body = input.body ? JSON.stringify(input.body) : null;
      response = await withFacetRecovery(
        (reason) => this.abortAppFacet(reason),
        () =>
          this.getFacet(input.appId).fetch(
            this.#contextRequest(input.appId, input.method, input.path, body, "http"),
          ),
      );
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      await this.#finishInvocation(invocationId, false, errorMessage, startedAt);
      await this.#markLastError(errorMessage);
      throw err;
    }
    const bodyBuffer = await response.arrayBuffer();
    const headers = [];
    response.headers.forEach((v, k) => {
      headers.push([k, v]);
    });
    const ok = response.status >= 200 && response.status < 300;
    await this.#finishInvocation(invocationId, ok, null, startedAt);
    return { status: response.status, headers, body: bodyBuffer };
  }

  async queryDb(input) {
    const startedAt = Date.now();
    const limit = input.limit ?? 100;
    try {
      const result = await withFacetRecovery(
        (reason) => this.abortAppFacet(reason),
        () =>
          this.getFacet(input.appId).__sqlExec(
            input.sql,
            input.params ?? [],
            limit + 1,
          ),
      );
      const truncated = result.rows.length > limit;
      this.ctx.storage.sql.exec(
        "INSERT INTO invocations (id, at, kind, route, ok, duration_ms) VALUES (?, ?, 'db_query', 'db/query', 1, ?)",
        crypto.randomUUID(),
        startedAt,
        Date.now() - startedAt,
      );
      await this.#clearLastError();
      return {
        rows: truncated ? result.rows.slice(0, limit) : result.rows,
        rowsRead: result.rowsRead,
        rowsWritten: result.rowsWritten,
        truncated,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.ctx.storage.sql.exec(
        "INSERT INTO invocations (id, at, kind, route, ok, error_message, duration_ms) VALUES (?, ?, 'db_query', 'db/query', 0, ?, ?)",
        crypto.randomUUID(),
        startedAt,
        errorMessage,
        Date.now() - startedAt,
      );
      await this.#markLastError(errorMessage);
      throw err;
    }
  }

  /** Tail-worker re-entry: log writes racing dispatches on this DO. */
  async ingestLogs(events) {
    for (const event of events) {
      this.ctx.storage.sql.exec(
        "INSERT INTO worker_logs (at, level, message) VALUES (?, ?, ?)",
        event.at,
        event.level,
        event.message,
      );
    }
  }

  /** APP_PLATFORM re-entry from inside the facet. */
  async finalizeInvocation(input) {
    this.ctx.storage.sql.exec(
      "UPDATE invocations SET ok = ?, error_message = ?, duration_ms = ? WHERE id = ?",
      input.ok ? 1 : 0,
      input.errorMessage ?? null,
      input.durationMs ?? null,
      input.invocationId,
    );
  }

  async stats() {
    const logs = this.ctx.storage.sql
      .exec("SELECT COUNT(*) AS n FROM worker_logs")
      .toArray()[0].n;
    const invocations = this.ctx.storage.sql
      .exec("SELECT COUNT(*) AS n, SUM(ok) AS ok FROM invocations")
      .toArray()[0];
    const lastError = this.ctx.storage.sql
      .exec("SELECT v FROM meta WHERE k = 'lastError'")
      .toArray();
    return {
      workerLogs: logs,
      invocations: invocations.n,
      invocationsOk: invocations.ok,
      lastError: lastError[0]?.v ?? null,
      codeVersion: this.codeVersion,
    };
  }

  async #finishInvocation(id, ok, errorMessage, startedAt) {
    this.ctx.storage.sql.exec(
      "UPDATE invocations SET ok = ?, error_message = ?, duration_ms = ? WHERE id = ?",
      ok ? 1 : 0,
      errorMessage,
      Date.now() - startedAt,
      id,
    );
  }

  async #markLastError(message) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (k, v) VALUES ('lastError', ?)",
      message,
    );
  }

  async #clearLastError() {
    this.ctx.storage.sql.exec("DELETE FROM meta WHERE k = 'lastError'");
  }
}

/* ──────────────────── the driver (an agent-shaped user) ─────────────────── */

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms`)), ms),
    ),
  ]);

const outcomeOf = async (promise) => {
  try {
    const result = await withTimeout(promise, 20_000);
    if (result && typeof result.status === "number") {
      return `http:${result.status}`;
    }
    return "ok";
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : err}`;
  }
};

/**
 * One "someone is actually using the app" round: a burst of concurrent
 * dispatches (bulk writes, row reads, an outbound fetch) interleaved with
 * agent-shaped db/query calls, every dispatch also firing tail logs back
 * into the DO. Optionally a redeploy mid-burst (deploys correlate with
 * production wedges).
 */
export const runSaunaUse = async (env, opts) => {
  const name = opts.name ?? "sauna-1";
  const burst = opts.burst ?? 4;
  const redeployEvery = opts.redeployEvery ?? 0;
  const round = opts.round ?? 0;
  const stub = env.SAUNA_SUP.get(env.SAUNA_SUP.idFromName(name));

  const ops = [];
  for (let i = 0; i < burst; i++) {
    ops.push(
      outcomeOf(stub.dispatch({ appId: name, method: "POST", path: "/api/bulk", body: { n: 40 } })),
      outcomeOf(stub.dispatch({ appId: name, method: "GET", path: "/api/items" })),
      outcomeOf(stub.dispatch({ appId: name, method: "POST", path: "/api/items", body: { label: `r${round}-${i}`, amount: i * 1.5 } })),
      outcomeOf(stub.dispatch({ appId: name, method: "GET", path: "/api/out" })),
      outcomeOf(stub.queryDb({ appId: name, sql: "INSERT INTO events (kind, payload, at) VALUES (?, ?, ?)", params: ["agent", JSON.stringify({ round, i }), Date.now()] })),
      outcomeOf(stub.queryDb({ appId: name, sql: "SELECT id, kind, payload, at FROM events ORDER BY id DESC LIMIT 25", params: [], limit: 25 })),
    );
  }
  if (redeployEvery > 0 && round % redeployEvery === redeployEvery - 1) {
    ops.push(outcomeOf(stub.redeploy(name)));
  }
  return await Promise.all(ops);
};

export const saunaRoutes = async (url, env) => {
  const name = url.searchParams.get("name") ?? "sauna-1";
  switch (url.pathname) {
    case "/sauna/use": {
      const rounds = Number(url.searchParams.get("rounds") ?? 3);
      const burst = Number(url.searchParams.get("burst") ?? 4);
      const redeployEvery = Number(url.searchParams.get("redeployEvery") ?? 0);
      const tally = {};
      let deserialize = 0;
      for (let round = 0; round < rounds; round++) {
        const outcomes = await runSaunaUse(env, { name, burst, redeployEvery, round });
        for (const outcome of outcomes) {
          tally[outcome] = (tally[outcome] ?? 0) + 1;
          if (outcome.includes(DESERIALIZE_NEEDLE)) {
            deserialize += 1;
          }
        }
      }
      const stub = env.SAUNA_SUP.get(env.SAUNA_SUP.idFromName(name));
      const stats = await stub.stats().catch((err) => ({
        statsError: String(err?.message ?? err),
      }));
      return Response.json({ name, rounds, burst, deserialize, tally, stats });
    }
    case "/sauna/verify": {
      const stub = env.SAUNA_SUP.get(env.SAUNA_SUP.idFromName(name));
      try {
        await stub.queryDb({ appId: name, sql: "SELECT 1 AS one", params: [], limit: 1 });
        const dispatched = await stub.dispatch({ appId: name, method: "GET", path: "/api/items" });
        return Response.json({ name, wedged: false, status: dispatched.status });
      } catch (err) {
        const message = String(err?.message ?? err);
        return Response.json(
          { name, wedged: message.includes(DESERIALIZE_NEEDLE), error: message },
          { status: 503 },
        );
      }
    }
    case "/sauna/stats": {
      const stub = env.SAUNA_SUP.get(env.SAUNA_SUP.idFromName(name));
      return Response.json(await stub.stats());
    }
    default:
      return null;
  }
};
