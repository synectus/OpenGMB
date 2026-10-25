import { clientIpFromForwardedFor, intFromEnv } from "@opengmb/core/limits";

/** Request headers the MCP protocol uses; everything else (cookies, host, hop-by-hop) stays behind. */
const FORWARD_REQUEST = ["authorization", "mcp-session-id", "mcp-protocol-version", "accept", "content-type", "last-event-id"];
/** Response headers worth returning. content-encoding/length are dropped because fetch already decoded the body. */
const FORWARD_RESPONSE = ["content-type", "mcp-session-id", "www-authenticate", "retry-after", "allow", "syngmb-api-version"];

export type McpProxyOptions = {
  /** Base URL of the internal MCP service (no path). Default: MCP_INTERNAL_URL, else the local dev port. */
  upstream?: string;
  /** Reverse proxies in front of the web app (a Traefik proxy is 1). */
  proxyHops?: number;
  /** Path on the internal service. Default "/mcp"; the REST API passes "/v1/actions/<name>". Must start with "/v1/" or be "/mcp". */
  upstreamPath?: string;
};

export function mcpUpstreamFrom(env: Record<string, string | undefined>): string {
  return (env.MCP_INTERNAL_URL?.trim() || `http://localhost:${env.MCP_PORT?.trim() || "3100"}`).replace(/\/+$/, "");
}

/**
 * Pass a request for the public /mcp path through to the internal MCP service and hand its response
 * back as a stream, so event streams arrive chunk by chunk. Authentication stays with the MCP
 * service (bearer token). The MCP service rate-limits bad tokens per client address, so this sends
 * it ONE X-Forwarded-For entry: the real client as Traefik saw it. Without that, every outside caller would
 * share the web container's address and one bad actor could lock everyone out.
 */
export async function proxyMcp(request: Request, opts: McpProxyOptions = {}): Promise<Response> {
  const upstream = opts.upstream ?? mcpUpstreamFrom(process.env);
  const upstreamPath = opts.upstreamPath ?? "/mcp";
  if (upstreamPath !== "/mcp" && !upstreamPath.startsWith("/v1/")) {
    return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  const hops = opts.proxyHops ?? intFromEnv("WEB_PROXY_HOPS", 1);
  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const v = request.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  headers.set("x-forwarded-for", clientIpFromForwardedFor(request.headers.get("x-forwarded-for"), hops));

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let res: Response;
  try {
    res = await fetch(`${upstream}${upstreamPath}`, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      // Node's fetch requires this to send a streamed request body.
      ...(hasBody ? { duplex: "half" } : {}),
      signal: request.signal,
      redirect: "manual",
      cache: "no-store",
    } as RequestInit);
  } catch {
    return Response.json({ error: "mcp_unavailable" }, { status: 502, headers: { "cache-control": "no-store" } });
  }

  const out = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const v = res.headers.get(name);
    if (v !== null) out.set(name, v);
  }
  // no-transform keeps Next's compression from buffering an event stream; x-accel-buffering is for nginx-style proxies.
  out.set("cache-control", "no-store, no-transform");
  out.set("x-accel-buffering", "no");
  return new Response(res.body, { status: res.status, headers: out });
}
