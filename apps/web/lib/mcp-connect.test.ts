import { describe, expect, it } from "vitest";
import { claudeDesktopConfig, mcpCommand, mcpUrlFrom } from "./mcp-connect";

describe("mcpUrlFrom", () => {
  it("uses MCP_PUBLIC_URL when it is https", () => {
    expect(mcpUrlFrom({ MCP_PUBLIC_URL: " https://mcp.example.test/mcp ", NODE_ENV: "production" })).toBe(
      "https://mcp.example.test/mcp",
    );
  });

  it("refuses a plain-http or malformed public URL (a bearer token must not travel in clear)", () => {
    expect(mcpUrlFrom({ MCP_PUBLIC_URL: "http://mcp.example.test/mcp", NODE_ENV: "production" })).toBeNull();
    expect(mcpUrlFrom({ MCP_PUBLIC_URL: "not a url", NODE_ENV: "production" })).toBeNull();
  });

  it("falls back to the local MCP port outside production, and to nothing in production", () => {
    expect(mcpUrlFrom({ NODE_ENV: "development", MCP_PORT: "3111" })).toBe("http://localhost:3111/mcp");
    expect(mcpUrlFrom({ NODE_ENV: "test" })).toBe("http://localhost:3100/mcp");
    expect(mcpUrlFrom({ NODE_ENV: "production" })).toBeNull();
  });
});

describe("mcpCommand", () => {
  it("is the exact claude mcp add shape, with a placeholder until a token exists", () => {
    expect(mcpCommand("https://mcp.example.test/mcp")).toBe(
      'claude mcp add --transport http opengmb https://mcp.example.test/mcp --header "Authorization: Bearer <token>"',
    );
    expect(mcpCommand("https://m/mcp", "sgmb_abc")).toContain('"Authorization: Bearer sgmb_abc"');
  });
});

describe("claudeDesktopConfig", () => {
  it("is valid JSON that starts the mcp-remote bridge with the public address and the bearer header", () => {
    const cfg = JSON.parse(claudeDesktopConfig("https://opengmb.example.com/mcp", "sgmb_abc"));
    expect(cfg.mcpServers.opengmb).toEqual({
      command: "npx",
      args: ["-y", "mcp-remote", "https://opengmb.example.com/mcp", "--header", "Authorization: Bearer sgmb_abc"],
    });
    expect(claudeDesktopConfig("https://m/mcp")).toContain("Bearer <token>");
  });
});
