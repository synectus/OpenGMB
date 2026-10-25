import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { publicLimits } from "@opengmb/core/limits";
import { proxy } from "../proxy";

describe("proxy.ts applies the public endpoint limits", () => {
  it("the real proxy answers 429 on /go/ once an IP is over its limit, and still redirects others to sign-in", () => {
    const max = publicLimits().perMinute["review-link"];
    const hit = (ip: string) =>
      proxy(
        new NextRequest("http://localhost:3000/go/some-slug", {
          headers: { "x-forwarded-for": ip },
        }),
      );
    for (let i = 0; i < max; i++) expect(hit("203.0.113.77").status).not.toBe(429);
    expect(hit("203.0.113.77").status).toBe(429);
    expect(hit("203.0.113.78").status).not.toBe(429);
    // A private page is untouched by the limiter and still needs a session cookie.
    const priv = proxy(
      new NextRequest("http://localhost:3000/reports", {
        headers: { "x-forwarded-for": "203.0.113.77" },
      }),
    );
    expect(priv.status).toBe(307);
  });

  it("the status page has its own, lower limit and stays public", () => {
    const max = publicLimits().perMinute.status;
    const hit = () =>
      proxy(new NextRequest("http://localhost:3000/status", { headers: { "x-forwarded-for": "203.0.113.90" } }));
    for (let i = 0; i < max; i++) {
      const r = hit();
      expect(r.status).not.toBe(429);
      expect(r.status).not.toBe(307);
    }
    expect(hit().status).toBe(429);
  });
});
