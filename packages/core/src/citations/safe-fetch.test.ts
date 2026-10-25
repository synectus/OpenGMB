import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { safeFetch } from "./safe-fetch";

// A local server stands in for a directory. Loopback is allowed only through the test policy, so
// the refusals below are the production behaviour (no policy).
let server: http.Server;
let base: string;
const sockets = new Set<import("node:net").Socket>();
const policy = { allowAddress: (ip: string) => ip === "127.0.0.1", allowPort: () => true };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const big = "x".repeat(2000);
    switch (req.url) {
      case "/ok": res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return void res.end(`<html>${req.headers["user-agent"]}</html>`);
      case "/json": res.writeHead(200, { "content-type": "application/json" }); return void res.end("{}");
      case "/big": res.writeHead(200, { "content-type": "text/html" }); return void res.end(big);
      case "/forbidden": res.writeHead(403, { "content-type": "text/html" }); return void res.end("no");
      case "/missing": res.writeHead(404, { "content-type": "text/html" }); return void res.end("no");
      case "/stream": res.writeHead(200, { "content-type": "text/html" }); res.write(big); return void res.end(big);
      case "/hang": return; // never answers
      case "/r1": res.writeHead(302, { location: "/r2" }); return void res.end();
      case "/r2": res.writeHead(302, { location: "/r3" }); return void res.end();
      case "/r3": res.writeHead(302, { location: "/r4" }); return void res.end();
      case "/r4": res.writeHead(302, { location: "/ok" }); return void res.end();
      case "/to-meta": res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); return void res.end();
      case "/to-private": res.writeHead(302, { location: "http://10.0.0.5/admin" }); return void res.end();
      case "/to-ftp": res.writeHead(302, { location: "ftp://example.com/x" }); return void res.end();
      default: res.writeHead(404); return void res.end();
    }
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
});

describe("safeFetch: what it fetches", () => {
  it("fetches an html page with a clear User-Agent", async () => {
    const r = await safeFetch(`${base}/ok`, { policy });
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.html).toContain("OpenGMB-ListingCheck");
  });
  it("follows up to 3 redirects and reports the final url", async () => {
    const r = await safeFetch(`${base}/r2`, { policy });
    expect(r.ok && r.finalUrl).toBe(`${base}/ok`);
  });
});

describe("safeFetch: refusals", () => {
  it.each([
    ["ftp scheme", "ftp://example.com/x", "scheme"],
    ["file scheme", "file:///etc/passwd", "scheme"],
    ["not a url", "not a url", "invalid_url"],
    ["user info", "https://user:pw@example.com/", "userinfo"],
    ["odd port", "https://example.com:8443/", "port"],
    ["loopback v4", "http://127.0.0.1/", "blocked_address"],
    ["private 10/8", "http://10.1.2.3/", "blocked_address"],
    ["private 192.168", "http://192.168.1.1/", "blocked_address"],
    ["private 172.16", "http://172.16.0.1/", "blocked_address"],
    ["metadata", "http://169.254.169.254/latest/meta-data/", "blocked_address"],
    ["loopback v6", "http://[::1]/", "blocked_address"],
    ["link-local v6", "http://[fe80::1]/", "blocked_address"],
    ["unique-local v6", "http://[fd00::1]/", "blocked_address"],
    ["v4-mapped v6 metadata", "http://[::ffff:169.254.169.254]/", "blocked_address"],
    ["localhost", "http://localhost/", "blocked_address"],
    ["subdomain of localhost", "http://a.localhost/", "blocked_address"],
  ])("refuses %s", async (_n, url, reason) => {
    expect(await safeFetch(url)).toEqual({ ok: false, reason });
  });

  it("refuses a name that resolves to a private address, even next to a public one", async () => {
    const mixed = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.9", family: 4 }];
    expect(await safeFetch("https://rebind.example/", { resolve: mixed })).toEqual({ ok: false, reason: "blocked_address" });
  });
  it("refuses a name that resolves to the metadata address", async () => {
    const meta = async () => [{ address: "169.254.169.254", family: 4 }];
    expect(await safeFetch("https://meta.example/", { resolve: meta })).toEqual({ ok: false, reason: "blocked_address" });
  });
  it("reports a name that does not resolve", async () => {
    const none = async () => { throw new Error("ENOTFOUND"); };
    expect(await safeFetch("https://nope.example/", { resolve: none })).toEqual({ ok: false, reason: "dns" });
  });
  it("re-checks every redirect hop: public to metadata, to private, to a non-http scheme", async () => {
    expect(await safeFetch(`${base}/to-meta`, { policy })).toEqual({ ok: false, reason: "blocked_address" });
    expect(await safeFetch(`${base}/to-private`, { policy })).toEqual({ ok: false, reason: "blocked_address" });
    expect(await safeFetch(`${base}/to-ftp`, { policy })).toEqual({ ok: false, reason: "scheme" });
  });
  it("stops after 3 redirects", async () => {
    expect(await safeFetch(`${base}/r1`, { policy })).toEqual({ ok: false, reason: "too_many_redirects" });
  });
  it("times out", async () => {
    expect(await safeFetch(`${base}/hang`, { policy, limits: { timeoutMs: 150 } })).toEqual({ ok: false, reason: "timeout" });
  });
  it("refuses a body over the size limit", async () => {
    expect(await safeFetch(`${base}/big`, { policy, limits: { maxBytes: 500 } })).toMatchObject({ ok: false, reason: "too_large" });
    // no content-length: stopped while reading
    expect(await safeFetch(`${base}/stream`, { policy, limits: { maxBytes: 500 } })).toMatchObject({ ok: false, reason: "too_large" });
  });
  it("refuses anything that is not html", async () => {
    expect(await safeFetch(`${base}/json`, { policy })).toMatchObject({ ok: false, reason: "not_html" });
  });
  it("calls a bot block a block, not a failure of the page", async () => {
    expect(await safeFetch(`${base}/forbidden`, { policy })).toEqual({ ok: false, reason: "blocked_by_site", status: 403 });
    expect(await safeFetch(`${base}/missing`, { policy })).toEqual({ ok: false, reason: "http_error", status: 404 });
  });
  it("blocks loopback at connect time when the name resolves public at check time is not possible: guarded lookup refuses", async () => {
    // The pre-check passes (public address) but the connect-time lookup uses the same resolver, so a
    // resolver that changes its answer is caught at connect.
    let n = 0;
    const flip = async () => (n++ === 0 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
    expect(await safeFetch("http://flip.example/", { resolve: flip })).toEqual({ ok: false, reason: "blocked_address" });
  });
  it("is not reachable without the test policy", async () => {
    expect(await safeFetch(`${base}/ok`)).toMatchObject({ ok: false });
  });
});
