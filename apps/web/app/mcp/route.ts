import { proxyMcp } from "../../lib/mcp-proxy";

// The public MCP address (MCP_PUBLIC_URL, https://<web domain>/mcp). It authenticates by bearer token, not
// by session; see lib/mcp-proxy.ts. Node runtime and no caching so the response streams through untouched.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => proxyMcp(request);
export const POST = (request: Request) => proxyMcp(request);
export const DELETE = (request: Request) => proxyMcp(request);
