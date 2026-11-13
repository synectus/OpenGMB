export function mcpCommand(url: string, token = "<token>"): string {
  return `claude mcp add --transport http opengmb ${url} --header "Authorization: Bearer ${token}"`;
}

/**
 * Claude Desktop only starts local programs, so it reaches a remote MCP address through the mcp-remote
 * bridge (needs Node.js on the computer). Goes in claude_desktop_config.json.
 */
export function claudeDesktopConfig(url: string, token = "<token>"): string {
  return JSON.stringify(
    {
      mcpServers: {
        opengmb: { command: "npx", args: ["-y", "mcp-remote", url, "--header", `Authorization: Bearer ${token}`] },
      },
    },
    null,
    2,
  );
}
