import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "../proxy";

const at = (host: string | null, path: string, cookie?: string) => {
  const headers: Record<string, string> = {};
  if (host) headers["x-forwarded-host"] = host;
  if (cookie) headers.cookie = cookie;
  return proxy(new NextRequest(`http://localhost:3000${path}`, { headers }));
};
const CUSTOM = "portal.example.com";

describe("proxy.ts on a custom host", () => {
  it("canary: the main host still rewrites signed-out / to the product page and serves /pricing", () => {
    expect(at(null, "/").headers.get("x-middleware-rewrite")).toContain("/site-home");
    const pricing = at("localhost", "/pricing");
    expect(pricing.status).toBe(200);
  });
  it("signed-out / redirects to /sign-in, with no /site-home rewrite", () => {
    const res = at(CUSTOM, "/");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/sign-in");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
  it("signed-in / goes to the app home", () => {
    const res = at(CUSTOM, "/", "better-auth.session_token=abc");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
  it("marketing pages answer 404, signed in or out", () => {
    for (const p of ["/pricing", "/contact", "/help", "/help/x", "/status", "/sitemap.xml", "/site-home"]) {
      expect(at(CUSTOM, p).status, p).toBe(404);
      expect(at(CUSTOM, p, "better-auth.session_token=abc").status, p).toBe(404);
    }
  });
  it("the legal pages, sign-in and the health check pass", () => {
    for (const p of ["/terms", "/privacy", "/refund-policy", "/sign-in", "/robots.txt", "/api/health"]) {
      expect(at(CUSTOM, p).status, p).toBe(200);
    }
  });
  it("/portal signed out redirects to /sign-in", () => {
    const res = at(CUSTOM, "/portal");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/sign-in");
  });
});
