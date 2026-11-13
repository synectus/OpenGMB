import { describe, expect, it } from "vitest";
import { oauthAddresses, oauthStartupLines, protectedResourceMetadata } from "./addresses";

describe("oauthAddresses", () => {
  it("canary: issuer is BETTER_AUTH_URL and the resource is MCP_PUBLIC_URL when set", () => {
    expect(oauthAddresses({ BETTER_AUTH_URL: "https://app.example.test/", MCP_PUBLIC_URL: " https://app.example.test/mcp " })).toEqual({
      issuer: "https://app.example.test",
      resource: "https://app.example.test/mcp",
      authorizationServerMetadataUrl: "https://app.example.test/.well-known/oauth-authorization-server",
      protectedResourceMetadataUrl: "https://app.example.test/.well-known/oauth-protected-resource/mcp",
    });
  });
  it("falls back to BETTER_AUTH_URL + /mcp when MCP_PUBLIC_URL is unset or blank", () => {
    expect(oauthAddresses({ BETTER_AUTH_URL: "https://self.example.test" })!.resource).toBe("https://self.example.test/mcp");
    expect(oauthAddresses({ BETTER_AUTH_URL: "https://self.example.test", MCP_PUBLIC_URL: "  " })!.resource).toBe("https://self.example.test/mcp");
  });
  it("development and e2e use the web origin's /mcp, never the MCP port", () => {
    expect(oauthAddresses({ BETTER_AUTH_URL: "http://localhost:3011", MCP_PORT: "3111", NODE_ENV: "development" })!.resource).toBe("http://localhost:3011/mcp");
  });
  it("strips query, fragment and trailing slashes", () => {
    expect(oauthAddresses({ BETTER_AUTH_URL: "https://a.example.test//?x=1#y" })!.issuer).toBe("https://a.example.test");
  });
  it("null without a usable BETTER_AUTH_URL (OAuth is off)", () => {
    expect(oauthAddresses({})).toBeNull();
    expect(oauthAddresses({ BETTER_AUTH_URL: "not a url" })).toBeNull();
  });
  it("an unusable MCP_PUBLIC_URL falls back to the web origin", () => {
    expect(oauthAddresses({ BETTER_AUTH_URL: "https://a.example.test", MCP_PUBLIC_URL: "nope" })!.resource).toBe("https://a.example.test/mcp");
  });
});

describe("oauthStartupLines", () => {
  it("prints oauth=on with both addresses", () => {
    expect(oauthStartupLines("web", { BETTER_AUTH_URL: "https://a.example.test", NODE_ENV: "production" })).toEqual([
      "[startup] web: oauth=on issuer=https://a.example.test resource=https://a.example.test/mcp",
    ]);
  });
  it("warns when either address is not https in production", () => {
    const lines = oauthStartupLines("mcp", { BETTER_AUTH_URL: "http://10.0.0.5:8080", NODE_ENV: "production" });
    expect(lines[1]).toBe("[startup] mcp: WARNING oauth issuer or resource is not https; claude.ai, Claude mobile and ChatGPT cannot connect");
  });
  it("no warning for http in development", () => {
    expect(oauthStartupLines("web", { BETTER_AUTH_URL: "http://localhost:3000", NODE_ENV: "development" })).toHaveLength(1);
  });
  it("oauth=off when BETTER_AUTH_URL is missing", () => {
    expect(oauthStartupLines("mcp", {})).toEqual(["[startup] mcp: oauth=off (BETTER_AUTH_URL is not set)"]);
  });
});

describe("protectedResourceMetadata", () => {
  it("names the resource and the authorization server (RFC 9728)", () => {
    const a = oauthAddresses({ BETTER_AUTH_URL: "https://app.example.test" })!;
    expect(protectedResourceMetadata(a)).toEqual({
      resource: "https://app.example.test/mcp",
      authorization_servers: ["https://app.example.test"],
      scopes_supported: ["mcp:read", "mcp:write", "offline_access"],
      bearer_methods_supported: ["header"],
      resource_name: "OpenGMB",
    });
  });
});
