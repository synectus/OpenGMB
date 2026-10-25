import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mcpUpstreamFrom, proxyMcp } from "./mcp-proxy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: Server;
let base: string;
let seen: { url?: string; method?: string; headers: IncomingHttpHeaders; body: string }[] = [];
let upstreamFinishedAt = 0;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({ url: req.url, method: req.method, headers: req.headers, body });
    if (req.headers.authorization === "Bearer bad") {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      return res.end('{"error":"unauthorized"}');
    }
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s1", "set-cookie": "leak=1" });
    for (const n of [1, 2, 3]) {
      res.write(`data: chunk-${n}\n\n`);
      await sleep(150);
    }
    upstreamFinishedAt = Date.now();
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (headers: Record<string, string> = {}, body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') =>
  new Request("https://opengmb.example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json", ...headers },
    body,
  });

describe("proxyMcp", () => {
  it("streams: the first chunk reaches the client before the upstream has finished, in order", async () => {
    upstreamFinishedAt = 0;
    const res = await proxyMcp(post({ accept: "application/json, text/event-stream" }), { upstream: base, proxyHops: 1 });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const first = dec.decode((await reader.read()).value);
    expect(first).toBe("data: chunk-1\n\n");
    expect(upstreamFinishedAt).toBe(0); // the upstream is still emitting
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += dec.decode(value);
    }
    expect(first + rest).toBe("data: chunk-1\n\ndata: chunk-2\n\ndata: chunk-3\n\n");
    expect(upstreamFinishedAt).toBeGreaterThan(0);
    console.log("mcp-proxy: 3 chunks received in order, first one before the upstream finished");
  });

  it("forwards Authorization, session id, accept, content-type and the body; drops cookies; sends one client address", async () => {
    seen = [];
    const res = await proxyMcp(
      post({ "mcp-session-id": "abc", cookie: "session=secret", "x-forwarded-for": "9.9.9.9, 198.51.100.7" }),
      { upstream: base, proxyHops: 1 },
    );
    await res.text();
    const h = seen[0]!.headers;
    expect(h.authorization).toBe("Bearer good");
    expect(h["mcp-session-id"]).toBe("abc");
    expect(h["content-type"]).toBe("application/json");
    expect(h.cookie).toBeUndefined();
    expect(h["x-forwarded-for"]).toBe("198.51.100.7"); // the spoofed leading entry is not passed on
    expect(seen[0]!.body).toContain("tools/list");
    expect(res.headers.get("mcp-session-id")).toBe("s1");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("no-transform");
  });

  it("returns the upstream's 401 and its challenge untouched", async () => {
    const res = await proxyMcp(post({ authorization: "Bearer bad" }), { upstream: base });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("answers 502 when the MCP service is down", async () => {
    const res = await proxyMcp(post(), { upstream: "http://127.0.0.1:1" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "mcp_unavailable" });
  });
});

describe("proxyMcp for the REST API", () => {
  const rest = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://opengmb.example.test/api${path}`, {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json", ...headers },
      body: "{}",
    });

  it("forwards /api/v1/actions/<name> to the service as /v1/actions/<name> with Authorization and one client address", async () => {
    seen = [];
    const res = await proxyMcp(
      rest("/v1/actions/reviews.list", { cookie: "session=secret", "x-forwarded-for": "9.9.9.9, 198.51.100.7" }),
      { upstream: base, proxyHops: 1, upstreamPath: "/v1/actions/reviews.list" },
    );
    await res.text();
    expect(seen[0]!.url).toBe("/v1/actions/reviews.list");
    expect(seen[0]!.headers.authorization).toBe("Bearer good");
    expect(seen[0]!.headers["x-forwarded-for"]).toBe("198.51.100.7");
    expect(seen[0]!.headers.cookie).toBeUndefined();
  });

  it("gives 502 when the service is down, and refuses an upstream path that is not /mcp or /v1/...", async () => {
    const down = await proxyMcp(rest("/v1/actions"), { upstream: "http://127.0.0.1:1", upstreamPath: "/v1/actions" });
    expect(down.status).toBe(502);
    seen = [];
    for (const upstreamPath of ["/healthz", "/", "//evil", "v1/actions"]) {
      const res = await proxyMcp(rest("/v1/actions"), { upstream: base, upstreamPath });
      expect(res.status, upstreamPath).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });
});

describe("mcpUpstreamFrom", () => {
  it("uses MCP_INTERNAL_URL without a trailing slash, else the local MCP port", () => {
    expect(mcpUpstreamFrom({ MCP_INTERNAL_URL: " http://mcp-app:3100/ " })).toBe("http://mcp-app:3100");
    expect(mcpUpstreamFrom({})).toBe("http://localhost:3100");
    expect(mcpUpstreamFrom({ MCP_PORT: "3111" })).toBe("http://localhost:3111");
  });
});
