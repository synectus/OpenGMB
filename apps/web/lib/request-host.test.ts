import { describe, expect, it } from "vitest";
import { hostAllowsOrg, isMainHost, isProductSitePath, requestHost } from "./request-host";

const h = (o: Record<string, string>) => new Headers(o);

describe("requestHost", () => {
  it("x-forwarded-host wins over host", () => {
    expect(requestHost(h({ "x-forwarded-host": "portal.example.com", host: "localhost:3000" }))).toBe("portal.example.com");
  });
  it("falls back to host, strips the port and lowercases", () => {
    expect(requestHost(h({ host: "Portal.Example.COM:3011" }))).toBe("portal.example.com");
    expect(requestHost(h({ "x-forwarded-host": "A.example.com:8443, b.example.com" }))).toBe("a.example.com");
  });
  it("null when no host is named", () => {
    expect(requestHost(h({}))).toBeNull();
  });
});

describe("isMainHost", () => {
  const base = "https://opengmb.example.com";
  it("true for the BETTER_AUTH_URL host, localhost, 127.0.0.1 and no host", () => {
    for (const x of ["opengmb.example.com", "localhost", "127.0.0.1", null]) expect(isMainHost(x, base), String(x)).toBe(true);
  });
  it("false for any other host", () => {
    expect(isMainHost("portal.example.com", base)).toBe(false);
    expect(isMainHost("opengmb.example.com.evil.com", base)).toBe(false);
    expect(isMainHost("portal.example.com", undefined)).toBe(false);
  });
});

describe("isProductSitePath", () => {
  it("marketing pages yes; legal, sign-in and app pages no", () => {
    for (const p of ["/site-home", "/pricing", "/contact", "/help", "/help/x", "/status", "/sitemap.xml"]) expect(isProductSitePath(p), p).toBe(true);
    for (const p of ["/terms", "/privacy", "/refund-policy", "/", "/sign-in", "/portal", "/api/health", "/helpful"]) expect(isProductSitePath(p), p).toBe(false);
  });
});

describe("hostAllowsOrg", () => {
  it("main host: always yes", () => {
    expect(hostAllowsOrg(null, [], true)).toBe(true);
    expect(hostAllowsOrg("a", ["b"], true)).toBe(true);
  });
  it("custom host: only a member of its own organization", () => {
    expect(hostAllowsOrg("a", ["a"], false)).toBe(true);
    expect(hostAllowsOrg("a", ["b", "a"], false)).toBe(true);
    expect(hostAllowsOrg("a", ["b"], false)).toBe(false);
    expect(hostAllowsOrg(null, ["a"], false)).toBe(false);
  });
});
