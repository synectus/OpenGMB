import { describe, expect, it } from "vitest";
import { isPublicPath } from "./public-paths";

const T = "A".repeat(43);

describe("isPublicPath", () => {
  it("canary: the share page and its PDF are public", () => {
    expect(isPublicPath(`/r/${T}`)).toBe(true);
    expect(isPublicPath(`/r/${T}/pdf`)).toBe(true);
  });
  it("keeps every path that was public before", () => {
    for (const p of ["/api/auth", "/api/auth/sign-in/email", "/api/health", "/sign-in", "/forgot-password", "/reset-password", "/mfa/verify"]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });
  it("app pages are still not public", () => {
    for (const p of ["/reviews", "/posts", "/approvals", "/settings/google", "/performance", "/locations"]) expect(isPublicPath(p), p).toBe(false);
  });
  it("library image path is public for exactly /m/<48 hex>", () => {
    const token = "ab12".repeat(12);
    expect(isPublicPath(`/m/${token}`)).toBe(true);
    expect(isPublicPath("/m/short")).toBe(false);
    expect(isPublicPath(`/m/${token}/x`)).toBe(false);
    expect(isPublicPath(`/m/${token.toUpperCase()}`)).toBe(false);
    expect(isPublicPath("/m")).toBe(false);
  });
  it("nothing else", () => {
    for (const p of ["/", "/r", `/r/${T}/other`, `/r/${T}/pdf/x`, "/reviews", "/reports", "/api/healthz", "/sign-in/x", "/reset-password/x", "/forgot-password/x", "/mfa/setup", "/api/reports/x/download"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
});

describe("review request email paths", () => {
  it("canary: the click link and the unsubscribe page are public, only for a 43 character token", () => {
    for (const p of [`/e/${T}`, `/e/${T}/unsubscribe`]) expect(isPublicPath(p), p).toBe(true);
    for (const p of ["/e", "/e/short", `/e/${T}/other`, `/e/${T}/unsubscribe/x`, `/e/${T}x`]) expect(isPublicPath(p), p).toBe(false);
  });
});

describe("review link paths", () => {
  it("canary: the redirect is public", () => {
    for (const p of ["/go/rivermoor-main", "/go/a1"]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });
  it("nothing around them is", () => {
    for (const p of ["/go", "/go/", "/go/a/b", "/go/Rivermoor", "/go/x", "/widget.json", "/api/review-links/abc/qr", "/reviews"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
});

describe("location landing pages", () => {
  it("canary: /l/<slug> is public, nothing around it is", () => {
    expect(isPublicPath("/l/acme-dental")).toBe(true);
    for (const p of ["/l", "/l/", "/l/a", "/l/Acme", "/l/acme/x", "/locations/abc"]) expect(isPublicPath(p), p).toBe(false);
  });
});

describe("Google Pub/Sub push path", () => {
  it("canary: /webhooks/google-pubsub is public, at exactly its path", () => {
    expect(isPublicPath("/webhooks/google-pubsub")).toBe(true);
    for (const p of ["/webhooks/google-pubsub/x", "/webhooks/google-pubsubx", "/webhooks/google"]) expect(isPublicPath(p), p).toBe(false);
  });
});

describe("DataForSEO pingback path", () => {
  it("canary: /webhooks/dataforseo is public, at exactly its path", () => {
    expect(isPublicPath("/webhooks/dataforseo")).toBe(true);
    for (const p of ["/webhooks/dataforseo/x", "/webhooks/dataforseox", "/webhooks", "/webhooks/"]) expect(isPublicPath(p), p).toBe(false);
  });
});

describe("MCP path", () => {
  it("canary: /api/v1/... (the REST API) is public, but /api/v1x and the other /api routes are not", () => {
    for (const p of ["/api/v1/actions", "/api/v1/actions/reviews.list", "/api/v1/actions/mcp.proposals.apply"]) {
      expect(isPublicPath(p), p).toBe(true);
    }
    for (const p of ["/api/v1", "/api/v1/", "/api/v1x", "/api/v1x/actions", "/api/reviews/export", "/api/v2/actions", "/api/v1/actions/"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it("canary: /mcp is public, and only that exact path", () => {
    expect(isPublicPath("/mcp")).toBe(true);
    for (const p of ["/mcp/", "/mcp/x", "/mcpx", "/x/mcp", "/api/mcp", "/settings/mcp", "/MCP"]) expect(isPublicPath(p), p).toBe(false);
  });
  it("unknown paths still need a session", () => {
    for (const p of ["/anything", "/agents", "/mcp-admin"]) expect(isPublicPath(p), p).toBe(false);
  });
});
