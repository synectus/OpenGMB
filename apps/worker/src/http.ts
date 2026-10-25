import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PgBoss } from "pg-boss";
import {
  PUBSUB_MAX_BODY_BYTES,
  acceptPingback,
  acceptPubsubPush,
  type PubsubVerifyConfig,
} from "@opengmb/core";
import type { Db } from "@opengmb/db";

export const MAX_BODY_BYTES = PUBSUB_MAX_BODY_BYTES;

export type ServerDeps = {
  db: Db;
  /** Unused since the push logic moved to core (jobs are enqueued through the transaction); kept so callers need no change. */
  boss?: Pick<PgBoss, "send">;
  /**
   * null when PUBSUB_AUDIENCE / PUBSUB_SERVICE_ACCOUNT_EMAIL are unset (env or in-app): the webhook
   * answers 503. A function is called per request, so a key saved in the app applies without a restart.
   */
  pubsub: PubsubVerifyConfig | null | (() => PubsubVerifyConfig | null);
};

function reply(res: ServerResponse, status: number, body?: unknown, headers = {}) {
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
  } else {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }
}

/** Reads up to MAX_BODY_BYTES; returns null if the body is larger (the rest is discarded). */
async function readCapped(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) over = true;
    else chunks.push(c as Buffer);
  }
  return over ? null : Buffer.concat(chunks);
}

/**
 * The push logic (verify, size limit, parse, store, enqueue, response codes) lives in core
 * (acceptPubsubPush) and is shared with the web app's public /webhooks/google-pubsub route.
 */
async function handlePush(req: IncomingMessage, res: ServerResponse, deps: ServerDeps) {
  const pubsub = typeof deps.pubsub === "function" ? deps.pubsub() : deps.pubsub;
  const raw = pubsub ? await readCapped(req) : (req.resume(), null);
  const out = await acceptPubsubPush(deps.db, {
    config: pubsub,
    authorization: req.headers.authorization,
    rawBody: raw,
    surface: "worker",
  });
  return reply(res, out.status, out.body, out.status === 401 ? { "www-authenticate": "Bearer" } : {});
}

/**
 * DataForSEO pingback: GET (what DataForSEO sends) or POST /webhooks/dataforseo?id=<task>&token=<secret>.
 * The token is the per-task secret generated at submit. Unknown task and wrong token are both 401;
 * a repeat delivery is 200 and does nothing. The body is never read: results are fetched by the
 * collect job, so nothing in the request can influence what is stored.
 */
async function handleDataForSeo(req: IncomingMessage, res: ServerResponse, deps: ServerDeps) {
  const url = new URL(req.url ?? "", "http://worker.local");
  const id = url.searchParams.get("id");
  const token = url.searchParams.get("token");
  req.resume();
  if (!id || !token) return reply(res, 401, { error: "unauthorized" });
  const outcome = await acceptPingback(deps.db, { taskRef: id, token });
  if (outcome === "unauthorized") return reply(res, 401, { error: "unauthorized" });
  return reply(res, 200, { ok: true, duplicate: outcome === "duplicate" });
}

export async function startServer(port: number, deps: ServerDeps) {
  const http = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && path === "/healthz") return reply(res, 200, { ok: true });
      if (path === "/webhooks/dataforseo") {
        if (req.method !== "GET" && req.method !== "POST") {
          return reply(res, 405, { error: "method_not_allowed" }, { allow: "GET, POST" });
        }
        return await handleDataForSeo(req, res, deps);
      }
      if (path !== "/webhooks/google-pubsub") return reply(res, 404, { error: "not_found" });
      if (req.method !== "POST") {
        return reply(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
      }
      await handlePush(req, res, deps);
    } catch (e) {
      console.error("[worker] request failed", e);
      if (!res.headersSent) reply(res, 500, { error: "internal" });
      else res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, resolve);
  });
  return {
    port: (http.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}
