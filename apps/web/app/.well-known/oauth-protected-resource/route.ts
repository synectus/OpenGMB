import { oauthAddresses, protectedResourceMetadata } from "@opengmb/core";

// RFC 9728. Public, cacheable, readable cross-origin (browser-based MCP clients such as the Inspector fetch it).
export const dynamic = "force-dynamic";

export function GET() {
  const a = oauthAddresses(process.env);
  if (!a) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(protectedResourceMetadata(a), {
    headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" },
  });
}
