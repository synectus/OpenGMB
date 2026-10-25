type Env = Record<string, string | undefined>;

/**
 * The MCP endpoint people paste into their client. MCP_PUBLIC_URL is the full endpoint
 * (https://host/mcp); plain http is refused because the token travels in a header. Outside
 * production the local MCP server is the default. Null: this server has no public address.
 */
export function mcpUrlFrom(env: Env): string | null {
  const set = env.MCP_PUBLIC_URL?.trim();
  if (set) {
    try {
      const u = new URL(set);
      return u.protocol === "https:" ? u.toString().replace(/\/$/, "") : null;
    } catch {
      return null;
    }
  }
  return env.NODE_ENV === "production" ? null : `http://localhost:${env.MCP_PORT?.trim() || "3100"}/mcp`;
}

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
