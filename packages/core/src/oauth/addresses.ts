type Env = Record<string, string | undefined>;

/** What a client may ask for. Access comes from the api_tokens row, never from these (spec step 8). */
export const OAUTH_SCOPES = ["mcp:read", "mcp:write", "offline_access"] as const;

export type OAuthAddresses = {
  /** Issuer and authorization server: BETTER_AUTH_URL without a trailing slash. */
  issuer: string;
  /** The MCP resource URL tokens are bound to (RFC 8707): MCP_PUBLIC_URL, else BETTER_AUTH_URL + "/mcp". */
  resource: string;
  authorizationServerMetadataUrl: string;
  protectedResourceMetadataUrl: string;
};

function cleanUrl(value: string | undefined): string | null {
  const s = value?.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * The single source of the OAuth and MCP addresses, used by the web app (metadata, Agents page), the MCP
 * container (audience check, 401 header) and tests. No new env vars: OAuth only works through the web origin,
 * so development and e2e use BETTER_AUTH_URL + "/mcp" too. Null when BETTER_AUTH_URL is missing (OAuth off).
 */
export function oauthAddresses(env: Env = process.env): OAuthAddresses | null {
  const issuer = cleanUrl(env.BETTER_AUTH_URL);
  if (!issuer) return null;
  return {
    issuer,
    resource: cleanUrl(env.MCP_PUBLIC_URL) ?? `${issuer}/mcp`,
    authorizationServerMetadataUrl: `${issuer}/.well-known/oauth-authorization-server`,
    protectedResourceMetadataUrl: `${issuer}/.well-known/oauth-protected-resource/mcp`,
  };
}

export function oauthStartupLines(service: "web" | "mcp", env: Env = process.env): string[] {
  const a = oauthAddresses(env);
  if (!a) return [`[startup] ${service}: oauth=off (BETTER_AUTH_URL is not set)`];
  const lines = [`[startup] ${service}: oauth=on issuer=${a.issuer} resource=${a.resource}`];
  const insecure = !a.issuer.startsWith("https://") || !a.resource.startsWith("https://");
  if (insecure && env.NODE_ENV === "production") {
    lines.push(`[startup] ${service}: WARNING oauth issuer or resource is not https; claude.ai, Claude mobile and ChatGPT cannot connect`);
  }
  return lines;
}

/** RFC 9728 document served at the web origin root; the MCP SDK's schema checks it in apps/mcp (PR 2). */
export function protectedResourceMetadata(a: OAuthAddresses) {
  return {
    resource: a.resource,
    authorization_servers: [a.issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "OpenGMB",
  };
}
