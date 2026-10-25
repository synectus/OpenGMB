import { proxyMcp } from "../../../../lib/mcp-proxy";

// The public REST API, https://<web domain>/api/v1/actions[/<action>]. It authenticates by bearer token
// (checked by the MCP service, which serves it as /v1/*), not by session; see lib/mcp-proxy.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const toRest = (request: Request) =>
  proxyMcp(request, { upstreamPath: new URL(request.url).pathname.replace(/^\/api(?=\/v1\/)/, "") });

export const GET = toRest;
export const POST = toRest;
