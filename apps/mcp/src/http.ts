import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  API_TOKEN_PREFIX,
  CoreError,
  actions as registry,
  directoryActions,
  oauthAddresses,
  recordError,
  startIntegrations,
  toErrorInfo,
  verifyApiToken,
  verifyOAuthAccessToken,
  type AnyAction,
  type OAuthAddresses,
} from "@opengmb/core";
import { createDb, type Db } from "@opengmb/db";
import { createMcpServer } from "./server";
import { clientIp, createMcpLimiters, rateLimitsFromEnv, type McpRateLimits } from "./rateLimit";
import { handleRest, restError } from "./rest";

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export type StartOptions = {
  db?: Db;
  actions?: readonly AnyAction[];
  rateLimits?: McpRateLimits;
  /** OAuth issuer and resource; default oauthAddresses(process.env). null turns the JWT branch off. */
  oauth?: OAuthAddresses | null;
};

/**
 * Stateless Streamable HTTP MCP endpoint at POST /mcp plus GET /healthz.
 * Each request authenticates its Bearer token and gets its own server + transport.
 */
export async function startServer(port: number, opts: StartOptions = {}) {
  let ownedClose: (() => Promise<void>) | undefined;
  let db = opts.db;
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const created = createDb(url);
    db = created.db;
    await startIntegrations("mcp", db);
    ownedClose = () => created.sql.end();
  }
  const useDb = db;
  const useActions = opts.actions ?? registry;
  const limits = createMcpLimiters(opts.rateLimits ?? rateLimitsFromEnv());
  const oauth = opts.oauth !== undefined ? opts.oauth : oauthAddresses(process.env);

  const http = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
      const isRest = path === "/v1" || path.startsWith("/v1/");
      if (path !== "/mcp" && !isRest) return json(res, 404, { error: "not_found" });
      if (!isRest && req.method !== "POST") {
        return json(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
      }

      // One door for /mcp and /v1: the same bad-token block, token check and per-token request
      // budget, so REST and MCP calls of one token draw on the same limit.
      const deny = (status: number, code: string, message: string, headers: Record<string, string>) =>
        isRest
          ? restError(res, status, code, message, headers)
          : json(res, status, { error: code === "RATE_LIMITED" ? "rate_limited" : "unauthorized" }, headers);

      // Too many bad tokens from one address: refuse before spending a database lookup on it.
      const ip = clientIp(req, limits.cfg.proxyHops);
      const blocked = limits.authFailures.blockedFor(ip);
      if (blocked > 0) return deny(429, "RATE_LIMITED", "Too many requests", { "retry-after": String(blocked) });

      const header = req.headers.authorization ?? "";
      const token = /^Bearer (.+)$/i.exec(header)?.[1];
      // /mcp only: tell an OAuth client where to start (RFC 9728). /v1 keeps the bare header and sgmb_ tokens only.
      const challenge = !isRest && oauth ? `Bearer resource_metadata="${oauth.protectedResourceMetadataUrl}"` : "Bearer";
      let actor;
      let oauthCaller = false;
      try {
        if (!token) throw new CoreError("UNAUTHENTICATED", "Missing bearer token");
        oauthCaller = !isRest && !token.startsWith(API_TOKEN_PREFIX);
        actor =
          isRest || token.startsWith(API_TOKEN_PREFIX)
            ? await verifyApiToken(useDb, token)
            : await verifyOAuthAccessToken(useDb, token, oauth);
      } catch (e) {
        if (e instanceof CoreError) {
          // No Authorization header on /mcp is the required first discovery step (RFC 9728), and claude.ai and ChatGPT make it
          // from shared server addresses: do not count it. A present-but-invalid token, and any failure on /v1, still counts.
          if (header || isRest) limits.authFailures.hit(ip);
          return deny(401, "UNAUTHENTICATED", "Missing or invalid API token", { "www-authenticate": challenge });
        }
        throw e;
      }
      const over = limits.requests.hit(actor.apiTokenId ?? actor.userId);
      if (over > 0) return deny(429, "RATE_LIMITED", "Too many requests", { "retry-after": String(over) });

      if (isRest) return handleRest({ db: useDb, actor, actions: useActions, req, res, path });

      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        return json(res, 400, { error: "invalid_json" });
      }

      // OAuth connections (claude.ai, ChatGPT, the Connectors Directory) get the directory profile: no AI image generation,
      // no billing, no tools that are always refused to a token (mcp-tool-meta.ts). sgmb_ tokens and /v1 keep every tool.
      const toolset = oauthCaller ? directoryActions(useActions) : useActions;
      const mcp = createMcpServer({ db: useDb, actor, actions: toolset });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error("[mcp] request failed", e);
      void recordError(useDb, "mcp", toErrorInfo(e));
      if (!res.headersSent) json(res, 500, { error: "internal" });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, resolve);
  });
  const bound = (http.address() as AddressInfo).port;

  return {
    port: bound,
    close: async () => {
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await ownedClose?.();
    },
  };
}
