import { describe, expect, it } from "vitest";
import { claudeDesktopConfig, mcpCommand } from "./mcp-connect";

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
