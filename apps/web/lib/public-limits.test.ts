import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { publicLimits } from "@opengmb/core/limits";
import { createPublicLimiter } from "./public-limits";

const req = (path: string, ip: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: { "x-forwarded-for": ip } });

describe("public endpoint limits", () => {
  const cfg = {
    ...publicLimits({}),
    perMinute: { share: 3, "review-link": 2, widget: 2, image: 2, help: 2, status: 2, tools: 2, "tools-search": 2 },
  };

  it.each([
    ["/r/tok", "share", 3],
    ["/r/tok/pdf", "share", 3],
    ["/go/my-slug", "review-link", 2],
    ["/api/widget/my-slug", "widget", 2],
    ["/m/" + "a".repeat(48), "image", 2],
    ["/api/tools/check", "tools", 2],
  ])("%s: over the limit is 429 with Retry-After; another IP is unaffected", (path, _name, max) => {
    const check = createPublicLimiter(cfg, () => 0);
    for (let i = 0; i < max; i++)
      expect(check(req(path, "198.51.100.1")), `hit ${i + 1}`).toBeNull();
    const blocked = check(req(path, "198.51.100.1"));
    expect(blocked?.status).toBe(429);
    expect(Number(blocked?.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(check(req(path, "198.51.100.2"))).toBeNull();
  });

  it("endpoint families have separate buckets, and the window resets", () => {
    let t = 0;
    const check = createPublicLimiter(cfg, () => t);
    for (let i = 0; i < 3; i++) check(req("/r/tok", "198.51.100.1"));
    expect(check(req("/r/tok", "198.51.100.1"))?.status).toBe(429);
    expect(check(req("/go/slug", "198.51.100.1"))).toBeNull();
    t = 60_000;
    expect(check(req("/r/tok", "198.51.100.1"))).toBeNull();
  });

  it("never limits a path that is not a public endpoint", () => {
    const check = createPublicLimiter(
      { ...cfg, perMinute: { share: 1, "review-link": 1, widget: 1, image: 1, help: 1, status: 1, tools: 1, "tools-search": 1 } },
      () => 0,
    );
    for (let i = 0; i < 5; i++) {
      expect(check(req("/widget.js", "198.51.100.1"))).toBeNull();
      expect(check(req("/sign-in", "198.51.100.1"))).toBeNull();
    }
  });
});
