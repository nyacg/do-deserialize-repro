import { WorkerEntrypoint } from "cloudflare:workers";
import { describe, richValue } from "./worker.js";

/**
 * Cross-process JS RPC harness (scripts/rpc-skew.sh). Two workerd processes
 * on two different builds talk over a capnp CONNECT channel
 * (`capnpConnectHost`), which is the transport Cloudflare uses to deliver
 * JSRPC between machines — so one build serializes the V8 payload and the
 * other deserializes it. That is the production hop (`rpc_worker_to_do`);
 * scripts/skew.sh can only swap builds under DO storage, whose writes are
 * version-pinned and therefore never trip the version check.
 *
 * The same module runs on both sides. External services expose only their
 * default entrypoint, so one class serves both roles: `fetch` drives the
 * client, `echo`/`emit` answer on the peer.
 */
export default class extends WorkerEntrypoint {
  /** Client build serializes the argument -> peer build deserializes it. */
  async echo(value) {
    return { echoed: value, from: "peer", received: typeof value };
  }

  /** Peer build serializes the return value -> client build deserializes it. */
  async emit() {
    return richValue();
  }

  async fetch(request) {
    const routes = {
      "/echo": async () => await this.env.PEER.echo(richValue()),
      "/emit": async () => await this.env.PEER.emit(),
    };
    const route = routes[new URL(request.url).pathname];
    if (!route) {
      return new Response("routes: /echo /emit\n", { status: 404 });
    }
    try {
      return new Response(describe(await route()), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      return new Response(
        describe({ error: err instanceof Error ? err.message : String(err) }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }
}
