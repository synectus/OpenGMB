import { describe, expect, it } from "vitest";
import { PUBLIC_ENDPOINTS, lockoutConfig, publicEndpointFor, publicLimits } from "./config";
import { WindowLimiter, clientIpFromForwardedFor } from "./window";

describe("WindowLimiter.reset", () => {
  it("forgets one key and leaves the others", () => {
    const l = new WindowLimiter(1, 60_000, () => 0);
    l.hit("a");
    l.hit("b");
    expect(l.blockedFor("a")).toBeGreaterThan(0);
    l.reset("a");
    expect(l.blockedFor("a")).toBe(0);
    expect(l.blockedFor("b")).toBeGreaterThan(0);
  });
});

describe("clientIpFromForwardedFor", () => {
  it("takes the proxy-appended entry and falls back to the socket", () => {
    expect(clientIpFromForwardedFor("1.1.1.1, 198.51.100.7", 1)).toBe("198.51.100.7");
    expect(clientIpFromForwardedFor(null, 1, "10.0.0.9")).toBe("10.0.0.9");
    expect(clientIpFromForwardedFor(undefined, 1)).toBe("unknown");
  });
});

describe("config", () => {
  it("lockout defaults are conservative and come from env when valid", () => {
    expect(lockoutConfig({})).toEqual({ failures: 10, windowMinutes: 15 });
    expect(lockoutConfig({ AUTH_LOCKOUT_FAILURES: "5", AUTH_LOCKOUT_MINUTES: "x" })).toEqual({
      failures: 5,
      windowMinutes: 15,
    });
  });

  it("every public endpoint has a limit, and only the public paths map to one", () => {
    const limits = publicLimits({});
    expect(PUBLIC_ENDPOINTS.length).toBe(8);
    for (const e of PUBLIC_ENDPOINTS) expect(limits.perMinute[e]).toBeGreaterThan(0);
    expect(publicEndpointFor("/r/abc")).toBe("share");
    expect(publicEndpointFor("/r/abc/pdf")).toBe("share");
    expect(publicEndpointFor("/go/my-slug")).toBe("review-link");
    expect(publicEndpointFor("/api/widget/my-slug")).toBe("widget");
    expect(publicEndpointFor("/l/my-slug")).toBe("widget");
    expect(publicEndpointFor("/m/" + "a".repeat(48))).toBe("image");
    expect(publicEndpointFor("/help")).toBe("help");
    expect(publicEndpointFor("/help/reviews-and-replies")).toBe("help");
    expect(publicEndpointFor("/status")).toBe("status");
    expect(publicEndpointFor("/status/x")).toBeNull();
    expect(publicEndpointFor("/help/a/b")).toBeNull();
    expect(publicEndpointFor("/widget.js")).toBeNull();
    expect(publicEndpointFor("/sign-in")).toBeNull();
    expect(publicEndpointFor("/reports")).toBeNull();
  });
});

describe("free checker limits", () => {
  it("the free checkers have their own bucket", () => {
    expect(publicEndpointFor("/api/tools/check")).toBe("tools");
    expect(publicEndpointFor("/api/tools/check/x")).toBeNull();
    expect(publicEndpointFor("/api/tools/review-link/search")).toBe("tools-search");
    expect(publicEndpointFor("/api/tools/review-link/qr")).toBe("tools");
    expect(publicEndpointFor("/api/tools/review-link/other")).toBeNull();
    expect(publicLimits({}).perMinute["tools-search"]).toBe(5);
    expect(publicLimits({ PUBLIC_TOOLS_SEARCH_PER_MINUTE: "2" }).perMinute["tools-search"]).toBe(2);
    expect(publicEndpointFor("/tools/post-checker")).toBeNull(); // the page itself is not limited
    expect(publicLimits({}).perMinute.tools).toBe(20);
    expect(publicLimits({ PUBLIC_TOOLS_PER_MINUTE: "5" }).perMinute.tools).toBe(5);
  });
});

describe("WindowLimiter expiry", () => {
  it("drops an expired key once the window has passed, without waiting for 10,000 keys", () => {
    let t = 0;
    const l = new WindowLimiter(5, 1000, () => t);
    l.hit("old");
    t = 1500;
    l.hit("new");
    const keys = [...(l as unknown as { windows: Map<string, unknown> }).windows.keys()];
    expect(keys).toEqual(["new"]);
  });
});
