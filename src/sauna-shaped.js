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
 * SQLite writes bracketing every facet call, __sqlExec returning real row
 * sets (including BLOB columns), schedule-kind dispatches, and streamed
 * SSE responses piped across the facet and RPC boundaries.
 *
 * The hammer (DO alarms every ~20s per instance) keeps all of it running
 * around the clock — every alarm on an evicted instance is a genuine
 * hibernation wake + facet reboot, the restart-from-idle shape production
 * wedges follow. Strip pieces out once it reproduces.
 */

const DESERIALIZE_NEEDLE = "Unable to deserialize cloned data";
const RESET_NEEDLE = "caused object to be reset";
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
        return { columns: cursor.columnNames, rows: rows };
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
  "CREATE TABLE IF NOT EXISTS blobs (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL, at INTEGER NOT NULL)",
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
 * A user handler doing meaningful work: bulk writes, BLOB writes/reads,
 * row-returning reads, an SSE stream, a seed route for building real state
 * size, an onSchedule task, console.log on every request (drives the
 * tail -> ingestLogs channel), and an outbound fetch (globalOutbound).
 */
const HANDLER_SOURCE = `import { PAD } from "./pad.js";
import { PAD2 } from "./pad2.js";
import { PAD3 } from "./pad3.js";

const bulkWrite = (env, n, kind) => {
  for (let i = 0; i < n; i++) {
    env.sql.exec(
      "INSERT INTO events (kind, payload, at) VALUES (?, ?, ?)",
      [kind, JSON.stringify({ i: i, blob: "x".repeat(200) }), Date.now()],
    );
  }
};

export default {
  async onSchedule(env, ctx) {
    console.log("[app] onSchedule tick");
    bulkWrite(env, 20, "schedule");
    env.sql.query(
      "SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY n DESC",
    );
  },

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
      bulkWrite(env, body.n || 40, "bulk");
      const agg = env.sql.query(
        "SELECT kind, COUNT(*) AS n, MAX(at) AS latest FROM events GROUP BY kind",
      );
      console.log("[app] bulk wrote " + (body.n || 40) + " events");
      return Response.json({ ok: true, agg: agg });
    }
    if (url.pathname === "/api/blob" && request.method === "POST") {
      const body = await request.json();
      const n = body.n || 4;
      const kb = body.kb || 16;
      for (let i = 0; i < n; i++) {
        const bytes = new Uint8Array(kb * 1024);
        crypto.getRandomValues(bytes);
        env.sql.exec("INSERT INTO blobs (data, at) VALUES (?, ?)", [
          bytes.buffer,
          Date.now(),
        ]);
      }
      return Response.json({ ok: true, wrote: n, kb: kb });
    }
    if (url.pathname === "/api/blob") {
      const rows = env.sql.query(
        "SELECT id, data, at FROM blobs ORDER BY id DESC LIMIT 8",
      );
      let bytes = 0;
      for (const row of rows) {
        bytes += row.data.byteLength || 0;
      }
      return Response.json({ ok: true, rows: rows.length, bytes: bytes });
    }
    if (url.pathname === "/api/seed" && request.method === "POST") {
      const body = await request.json();
      const n = body.n || 1000;
      for (let i = 0; i < n; i++) {
        env.sql.exec(
          "INSERT INTO events (kind, payload, at) VALUES (?, ?, ?)",
          ["seed", "s".repeat(800), Date.now()],
        );
        if (i % 20 === 0) {
          const bytes = new Uint8Array(8 * 1024);
          crypto.getRandomValues(bytes);
          env.sql.exec("INSERT INTO blobs (data, at) VALUES (?, ?)", [
            bytes.buffer,
            Date.now(),
          ]);
        }
      }
      const total = env.sql.query("SELECT COUNT(*) AS n FROM events");
      return Response.json({ ok: true, events: total[0].n });
    }
    if (url.pathname === "/api/stream") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          for (let i = 0; i < 12; i++) {
            controller.enqueue(
              encoder.encode("data: chunk-" + i + " " + "y".repeat(256) + "\\n\\n"),
            );
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.pathname === "/api/out") {
      const res = await fetch("https://example.com/ping");
      return Response.json({ ok: true, upstream: res.status });
    }
    return Response.json({
      ok: true,
      pad: PAD.length + PAD2.length + PAD3.length,
    });
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
      await this.__dispatchSchedule(input);
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

  async __dispatchSchedule(input) {
    await this.__bootIfNeeded();
    recordInput(this, input);
    if (typeof handler.onSchedule !== "function") return;
    await handler.onSchedule(buildEnv(this), buildCtx(this, input));
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

/** Three ~512KB inert modules: real bundles are multi-module and
 * non-trivial to compile, which widens the facet boot window. */
const padModule = (name) =>
  `export const ${name} = ${JSON.stringify("x".repeat(524_288))};`;
const PAD_SOURCE = padModule("PAD");
const PAD2_SOURCE = padModule("PAD2");
const PAD3_SOURCE = padModule("PAD3");

const buildModules = () => ({
  "wrapper.js": WRAPPER_SOURCE,
  "handler.js": HANDLER_SOURCE,
  "env.js": ENV_SOURCE,
  "input.js": INPUT_SOURCE,
  "migrations.js": MIGRATIONS_SOURCE,
  "pad.js": PAD_SOURCE,
  "pad2.js": PAD2_SOURCE,
  "pad3.js": PAD3_SOURCE,
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

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms`)), ms),
    ),
  ]);

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
      /**
       * A probe that wakes an evicted instance boots the facet before any
       * alarm runs; without this it would boot in `full` regardless of the
       * armed mode and facets.get would keep that facet until eviction.
       */
      const hammer = await this.ctx.storage.get("hammer");
      this.facetMode = hammer?.facetMode ?? "full";
    });
  }

  /**
   * facetMode strips boot-config pieces to isolate the wedge channel:
   * full | no-tails | no-outbound | no-platform | bare. Mode is part of
   * the runtime id so cached loader workers never cross modes.
   */
  getFacet(appId) {
    const mode = this.facetMode ?? "full";
    const exportsAny = this.ctx.exports;
    const runtimeId = `${appId}-v${this.codeVersion}-${mode}`;
    return this.ctx.facets.get("app", async () => {
      const config = {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
        mainModule: "wrapper.js",
        modules: buildModules(),
      };
      if (mode !== "bare" && mode !== "no-platform") {
        config.env = {
          APP_PLATFORM: exportsAny.AppInvocationControl({
            props: { userId: "repro-user", appId },
          }),
        };
      }
      if (mode !== "bare" && mode !== "no-outbound") {
        config.globalOutbound = exportsAny.AppPipedreamProxy({
          props: {
            userId: "repro-user",
            appId,
            organizationId: "repro-org",
            accounts: [
              { id: "acct_1", provider: "google", scopes: ["a", "b"] },
              { id: "acct_2", provider: "notion", scopes: ["c"] },
            ],
            connections: [{ id: "conn_1", kind: "postgres", label: "main" }],
          },
        });
      }
      if (mode !== "bare" && mode !== "no-tails") {
        config.tails = [
          exportsAny.AppLogTail({ props: { userId: "repro-user", appId } }),
        ];
      }
      const loaded = this.env.LOADER.get(runtimeId, async () => config);
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
      this.#contextRequest(appId, "GET", "/", null, "http").request,
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
    return { request, invocationId };
  }

  async dispatch(input) {
    const startedAt = Date.now();
    const kind = input.kind ?? "http";
    const body = input.body ? JSON.stringify(input.body) : null;
    const first = this.#contextRequest(input.appId, input.method, input.path, body, kind);
    const invocationId = first.invocationId;
    this.ctx.storage.sql.exec(
      "INSERT INTO invocations (id, at, kind, route, ok) VALUES (?, ?, ?, ?, 0)",
      invocationId,
      startedAt,
      kind,
      input.path,
    );
    let response;
    try {
      let attempt = 0;
      response = await withFacetRecovery(
        (reason) => this.abortAppFacet(reason),
        () => {
          attempt += 1;
          const built =
            attempt === 1
              ? first
              : this.#contextRequest(input.appId, input.method, input.path, body, kind);
          return this.getFacet(input.appId).fetch(built.request);
        },
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.#finishInvocation(invocationId, false, errorMessage, startedAt);
      await this.#markLastError(errorMessage);
      throw err;
    }
    /**
     * Streamed responses cross the RPC boundary as a live stream through
     * an IdentityTransformStream, mirroring streamSerializedResponse.
     */
    const contentType = response.headers.get("content-type") ?? "";
    const headers = [];
    response.headers.forEach((v, k) => {
      headers.push([k, v]);
    });
    if (response.body && contentType.includes("text/event-stream")) {
      const { readable, writable } = new IdentityTransformStream();
      this.ctx.waitUntil(
        response.body
          .pipeTo(writable)
          .then(() => this.#finishInvocation(invocationId, true, null, startedAt))
          .catch((err) =>
            this.#finishInvocation(
              invocationId,
              false,
              `stream ended early: ${err instanceof Error ? err.message : err}`,
              startedAt,
            ),
          ),
      );
      return { status: response.status, headers, stream: readable };
    }
    const bodyBuffer = await response.arrayBuffer();
    const ok = response.status >= 200 && response.status < 300;
    await this.#finishInvocation(invocationId, ok, null, startedAt);
    return { status: response.status, headers, body: bodyBuffer };
  }

  /** Scheduled-task shape: production wedge timestamps cluster on the
   * quarter-hour boundaries these fire on. */
  async scheduleDispatch(appId) {
    return await this.dispatch({
      appId,
      method: "POST",
      path: "/__schedule",
      kind: "schedule",
    });
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

  async stats(appId) {
    const logs = this.ctx.storage.sql
      .exec("SELECT COUNT(*) AS n FROM worker_logs")
      .toArray()[0].n;
    const invocations = this.ctx.storage.sql
      .exec("SELECT COUNT(*) AS n, SUM(ok) AS ok FROM invocations")
      .toArray()[0];
    const lastError = this.ctx.storage.sql
      .exec("SELECT v FROM meta WHERE k = 'lastError'")
      .toArray();
    const hammerCfg = await this.ctx.storage.get("hammer");
    const facetEvents = await this.queryDb({
      appId: appId ?? hammerCfg?.appId ?? "stats-probe",
      sql: "SELECT COUNT(*) AS n FROM events",
      params: [],
      limit: 1,
    }).catch((err) => ({ error: String(err?.message ?? err) }));
    return {
      workerLogs: logs,
      invocations: invocations.n,
      invocationsOk: invocations.ok,
      lastError: lastError[0]?.v ?? null,
      codeVersion: this.codeVersion,
      facetMode: this.facetMode,
      facetEvents: facetEvents.rows?.[0]?.n ?? facetEvents.error,
      hammer: (await this.ctx.storage.get("hammer")) ?? null,
      hammerStats: (await this.ctx.storage.get("hammer-stats")) ?? null,
    };
  }

  /** Storage-only read: no SQL, no facet call, so polling never touches the facet channel. */
  async hammerStats() {
    return {
      hammer: (await this.ctx.storage.get("hammer")) ?? null,
      hammerStats: (await this.ctx.storage.get("hammer-stats")) ?? null,
    };
  }

  /* ──────────── the hammer: self-driving load via DO alarms ──────────── */

  async startHammer(cfg) {
    this.facetMode = cfg.facetMode ?? "full";
    await this.ctx.storage.put("hammer", {
      appId: cfg.appId,
      intervalMs: cfg.intervalMs ?? 20_000,
      redeployEvery: cfg.redeployEvery ?? 8,
      facetMode: cfg.facetMode ?? "full",
    });
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return { on: true };
  }

  async stopHammer() {
    await this.ctx.storage.delete("hammer");
    await this.ctx.storage.deleteAlarm();
    return { on: false };
  }

  async #drainStream(appId) {
    const result = await this.dispatch({ appId, method: "GET", path: "/api/stream" });
    if (result.stream) {
      const reader = result.stream.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
    return result;
  }

  /**
   * One compact production-shaped round against this instance. Alarms on
   * an evicted instance are genuine hibernation wakes: constructor,
   * facet reboot, migration-journal check — the restart-from-idle shape
   * production wedges follow. Never throws; never stops rescheduling.
   */
  async alarm() {
    const cfg = await this.ctx.storage.get("hammer");
    if (!cfg) {
      return;
    }
    const stats = (await this.ctx.storage.get("hammer-stats")) ?? {
      runs: 0,
      outcomes: 0,
      ok: 0,
      deserialize: 0,
      resets: 0,
      otherErrors: 0,
      hits: [],
      lastRunAt: null,
    };
    stats.runs += 1;
    stats.lastRunAt = new Date().toISOString();
    const appId = cfg.appId;
    this.facetMode = cfg.facetMode ?? "full";
    const outcomes = [];
    const record = async (promise) => {
      try {
        await withTimeout(promise, 25_000);
        outcomes.push("ok");
      } catch (err) {
        outcomes.push(`ERROR: ${err instanceof Error ? err.message : err}`);
      }
    };
    try {
      /**
       * Waves of <=4: the alarm is a single request context, and >4
       * concurrent dynamic-worker invocations per context trip a loader
       * cap production never hits (each dispatch has its own context).
       */
      await Promise.all([
        record(this.scheduleDispatch(appId)),
        record(this.dispatch({ appId, method: "POST", path: "/api/bulk", body: { n: 30 } })),
        record(this.dispatch({ appId, method: "POST", path: "/api/blob", body: { n: 3, kb: 24 } })),
        record(this.dispatch({ appId, method: "GET", path: "/api/items" })),
      ]);
      await Promise.all([
        record(this.dispatch({ appId, method: "GET", path: "/api/out" })),
        record(this.#drainStream(appId)),
        record(this.queryDb({ appId, sql: "SELECT id, data, at FROM blobs ORDER BY id DESC LIMIT 8", params: [], limit: 8 })),
        record(this.queryDb({ appId, sql: "SELECT id, kind, payload, at FROM events ORDER BY id DESC LIMIT 25", params: [], limit: 25 })),
      ]);
      await record(this.queryDb({ appId, sql: "INSERT INTO events (kind, payload, at) VALUES (?, ?, ?)", params: ["hammer", "h".repeat(300), Date.now()] }));
      if (stats.runs % cfg.redeployEvery === 0) {
        await record(this.redeploy(appId));
      }
      /** Keep state large but bounded: prune far tails every 50 runs. */
      if (stats.runs % 50 === 0) {
        await record(
          this.queryDb({
            appId,
            sql: "DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id),0) FROM events) - 60000",
            params: [],
          }),
        );
        await record(
          this.queryDb({
            appId,
            sql: "DELETE FROM blobs WHERE id < (SELECT COALESCE(MAX(id),0) FROM blobs) - 2000",
            params: [],
          }),
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM worker_logs WHERE id < (SELECT COALESCE(MAX(id),0) FROM worker_logs) - 20000",
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM invocations WHERE at < ?",
          Date.now() - 6 * 3_600_000,
        );
      }
    } catch (err) {
      outcomes.push(`ALARM ERROR: ${err instanceof Error ? err.message : err}`);
    }
    for (const outcome of outcomes) {
      stats.outcomes += 1;
      if (outcome === "ok") {
        stats.ok += 1;
      } else if (outcome.includes(DESERIALIZE_NEEDLE)) {
        stats.deserialize += 1;
        stats.hits = [
          ...stats.hits.slice(-19),
          { at: stats.lastRunAt, outcome: outcome.slice(0, 300) },
        ];
        console.error("SAUNA HAMMER HIT", appId, outcome.slice(0, 300));
      } else if (outcome.includes(RESET_NEEDLE)) {
        stats.resets += 1;
      } else {
        stats.otherErrors += 1;
      }
    }
    /** Every failed round, with the error text: non-deserialize failures
     * (e.g. `internal error; reference = …`) are otherwise only a count. */
    const failed = outcomes.filter((outcome) => outcome !== "ok");
    if (failed.length > 0) {
      stats.failedRuns = [
        ...(stats.failedRuns ?? []).slice(-39),
        {
          at: stats.lastRunAt,
          deserialize: failed.filter((o) => o.includes(DESERIALIZE_NEEDLE)).length,
          other: failed.filter((o) => !o.includes(DESERIALIZE_NEEDLE)).length,
          samples: [...new Set(failed.map((o) => o.slice(0, 160)))].slice(0, 3),
        },
      ];
    }
    await this.ctx.storage.put("hammer-stats", stats);
    await this.ctx.storage.setAlarm(Date.now() + cfg.intervalMs);
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

const outcomeOf = async (promise) => {
  try {
    const result = await withTimeout(promise, 20_000);
    if (result && result.stream) {
      const reader = result.stream.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      return `stream:${result.status}`;
    }
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
 * dispatches (bulk writes, blob writes/reads, row reads, an SSE stream,
 * an outbound fetch, a schedule tick) interleaved with agent-shaped
 * db/query calls, every dispatch also firing tail logs back into the DO.
 * Optionally a redeploy mid-burst.
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
      outcomeOf(stub.dispatch({ appId: name, method: "POST", path: "/api/blob", body: { n: 2, kb: 16 } })),
      outcomeOf(stub.dispatch({ appId: name, method: "GET", path: "/api/stream" })),
      outcomeOf(stub.dispatch({ appId: name, method: "GET", path: "/api/out" })),
      outcomeOf(stub.scheduleDispatch(name)),
      outcomeOf(stub.queryDb({ appId: name, sql: "INSERT INTO events (kind, payload, at) VALUES (?, ?, ?)", params: ["agent", JSON.stringify({ round, i }), Date.now()] })),
      outcomeOf(stub.queryDb({ appId: name, sql: "SELECT id, kind, payload, at FROM events ORDER BY id DESC LIMIT 25", params: [], limit: 25 })),
      outcomeOf(stub.queryDb({ appId: name, sql: "SELECT id, data, at FROM blobs ORDER BY id DESC LIMIT 8", params: [], limit: 8 })),
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
      const stats = await stub.stats(name).catch((err) => ({
        statsError: String(err?.message ?? err),
      }));
      return Response.json({ name, rounds, burst, deserialize, tally, stats });
    }
    case "/sauna/seed": {
      const rows = Number(url.searchParams.get("rows") ?? 20_000);
      const stub = env.SAUNA_SUP.get(env.SAUNA_SUP.idFromName(name));
      const perCall = 2_000;
      let seeded = 0;
      for (let i = 0; i < Math.ceil(rows / perCall); i++) {
        const result = await stub.dispatch({
          appId: name,
          method: "POST",
          path: "/api/seed",
          body: { n: perCall },
        });
        if (result.status !== 200) {
          return Response.json({ name, seeded, failedAt: result.status });
        }
        seeded += perCall;
      }
      return Response.json({ name, seeded });
    }
    case "/sauna/hammer": {
      const on = url.searchParams.get("on") !== "0";
      const fleet = Number(url.searchParams.get("fleet") ?? 0);
      const intervalMs = Number(url.searchParams.get("intervalMs") ?? 20_000);
      const redeployEvery = Number(url.searchParams.get("redeployEvery") ?? 8);
      const facetMode = url.searchParams.get("facetMode") ?? "full";
      const names = fleet > 0
        ? Array.from({ length: fleet }, (_, i) => `sauna-hammer-${i + 1}`)
        : [name];
      const results = {};
      for (const target of names) {
        const stub = env.SAUNA_SUP.get(env.SAUNA_SUP.idFromName(target));
        results[target] = on
          ? await stub.startHammer({ appId: target, intervalMs, redeployEvery, facetMode })
          : await stub.stopHammer();
      }
      return Response.json(results);
    }
    case "/sauna/fleet": {
      const n = Number(url.searchParams.get("n") ?? 12);
      const prefix = url.searchParams.get("prefix") ?? "sauna-hammer-";
      /** light=1 reads persisted counters only — no facet probe per instance. */
      const light = url.searchParams.get("light") === "1";
      const fleet = {};
      const totals = { runs: 0, outcomes: 0, ok: 0, deserialize: 0, resets: 0, otherErrors: 0 };
      for (let i = 1; i <= n; i++) {
        const target = `${prefix}${i}`;
        const stub = env.SAUNA_SUP.get(env.SAUNA_SUP.idFromName(target));
        try {
          const stats = await withTimeout(
            light ? stub.hammerStats() : stub.stats(target),
            15_000,
          );
          const h = stats.hammerStats;
          fleet[target] = {
            runs: h?.runs ?? 0,
            deserialize: h?.deserialize ?? 0,
            resets: h?.resets ?? 0,
            otherErrors: h?.otherErrors ?? 0,
            lastRunAt: h?.lastRunAt ?? null,
            mode: stats.hammer?.facetMode,
            facetEvents: stats.facetEvents,
            lastError: stats.lastError,
            hits: h?.hits?.length ? h.hits : undefined,
            failedRuns: h?.failedRuns?.length ? h.failedRuns : undefined,
          };
          if (h) {
            totals.runs += h.runs;
            totals.outcomes += h.outcomes;
            totals.ok += h.ok;
            totals.deserialize += h.deserialize;
            totals.resets += h.resets;
            totals.otherErrors += h.otherErrors;
          }
        } catch (err) {
          fleet[target] = { error: String(err?.message ?? err) };
        }
      }
      return Response.json({ totals, fleet });
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
      return Response.json(await stub.stats(name));
    }
    default:
      return null;
  }
};
