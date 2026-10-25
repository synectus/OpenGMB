import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "../proxy";

const get = (path: string) => proxy(new NextRequest(`http://localhost:3000${path}`));
const nonceOf = (csp: string | null) => /script-src [^;]*'nonce-([^']+)'/.exec(csp ?? "")?.[1];

describe("proxy.ts sets a nonce-based Content-Security-Policy", () => {
  it("every page response carries a policy with a fresh nonce, and Next is handed the same policy and nonce", () => {
    const a = get("/sign-in");
    const b = get("/sign-in");
    const csp = a.headers.get("content-security-policy");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(nonceOf(csp)).toBeTruthy();
    expect(nonceOf(csp)).not.toBe(nonceOf(b.headers.get("content-security-policy")));
    // The headers forwarded to the page render (what Next stamps scripts from, and NonceStyle reads).
    expect(a.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
    expect(a.headers.get("x-middleware-request-x-nonce")).toBe(nonceOf(csp));
  });
});

describe("proxy.ts and the MCP endpoint", () => {
  it("/mcp passes through without a session cookie and without a CSP; an unknown path still redirects to sign-in", () => {
    const mcp = get("/mcp");
    expect(mcp.status).toBe(200);
    expect(mcp.headers.get("location")).toBeNull();
    expect(mcp.headers.get("content-security-policy")).toBeNull();
    const other = get("/mcp/extra");
    expect(other.status).toBe(307);
    expect(other.headers.get("location")).toContain("/sign-in");
    expect(get("/unknown-page").status).toBe(307);
  });
});


describe("proxy.ts and the REST API", () => {
  it("/api/v1/... passes through without a session cookie and without a CSP; /api/v1x and /api/reviews/export still redirect to sign-in", () => {
    for (const p of ["/api/v1/actions", "/api/v1/actions/reviews.list"]) {
      const r = get(p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get("location"), p).toBeNull();
      expect(r.headers.get("content-security-policy"), p).toBeNull();
    }
    for (const p of ["/api/v1x", "/api/v1", "/api/reviews/export"]) {
      const r = get(p);
      expect(r.status, p).toBe(307);
      expect(r.headers.get("location"), p).toContain("/sign-in");
    }
  });
});

describe("proxy.ts and the home page", () => {
  const home = (cookie?: string) =>
    proxy(new NextRequest("http://localhost:3000/", cookie ? { headers: { cookie } } : undefined));
  it("signed out, / is rewritten to the public product page with a CSP; it is not redirected", () => {
    const res = home();
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toContain("/site-home");
    expect(nonceOf(res.headers.get("content-security-policy"))).toBeTruthy();
  });
  it("signed in (session cookie present), / goes to the app home unchanged", () => {
    const res = home("better-auth.session_token=abc");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
  it("the rewrite target is not a public path: asking for /site-home signed out still redirects to sign-in", () => {
    const res = get("/site-home");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/sign-in");
  });
  it("app pages still redirect when signed out", () => {
    for (const p of ["/reviews", "/posts", "/approvals"]) expect(get(p).status, p).toBe(307);
  });
});
