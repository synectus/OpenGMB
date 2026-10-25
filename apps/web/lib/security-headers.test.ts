import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { SECURITY_HEADERS, buildCsp } from "./security-headers";

describe("security headers", () => {
  it("next.config applies them to every route", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    const all = rules.find((r) => r.source === "/:path*");
    expect(all, "a rule for /:path*").toBeDefined();
    const byKey = Object.fromEntries(all!.headers.map((h) => [h.key, h.value]));
    for (const { key, value } of SECURITY_HEADERS) expect(byKey[key], key).toBe(value);
  });

  it("refuses framing two ways and keeps secret-bearing URLs off other origins", () => {
    const get = (k: string) => SECURITY_HEADERS.find((h) => h.key === k)?.value;
    expect(get("X-Frame-Options")).toBe("DENY");
    expect(get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(get("Referrer-Policy")).toBe("same-origin");
    expect(get("X-Content-Type-Options")).toBe("nosniff");
  });

  describe("buildCsp", () => {
    const directive = (csp: string, name: string) =>
      csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

    it("production: scripts and styles only by nonce, no unsafe-eval, no unsafe-inline for scripts or style tags", () => {
      const csp = buildCsp("abc123", false);
      expect(directive(csp, "script-src")).toBe(
        "script-src 'self' 'nonce-abc123' 'strict-dynamic'",
      );
      expect(directive(csp, "style-src")).toBe(
        "style-src 'self' https://fonts.googleapis.com 'nonce-abc123'",
      );
      expect(csp).not.toMatch(/unsafe-eval/);
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'self'");
      // The one named exception: style attributes.
      expect(directive(csp, "style-src-attr")).toBe("style-src-attr 'unsafe-inline'");
    });

    it("development adds what hot reload needs, and only there", () => {
      const csp = buildCsp("abc123", true);
      expect(directive(csp, "script-src")).toContain("'unsafe-eval'");
      expect(directive(csp, "style-src")).toContain("'unsafe-inline'");
    });

    it("the nonce differs per request value it is given", () => {
      expect(buildCsp("a", false)).not.toBe(buildCsp("b", false));
    });
  });
});
