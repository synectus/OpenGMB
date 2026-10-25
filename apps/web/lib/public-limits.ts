import { NextResponse, type NextRequest } from "next/server";
import {
  WindowLimiter,
  clientIpFromForwardedFor,
  publicEndpointFor,
  publicLimits,
  type PublicEndpoint,
} from "@opengmb/core/limits";
import { hashIp } from "./hash-ip";

/**
 * Per-IP limits on the public, no-login endpoints (/r/, /go/, widget, /m/), applied from proxy.ts
 * with the same in-process fixed-window counter the MCP endpoint uses. One bucket per IP per
 * endpoint family, so a busy widget cannot lock someone out of their share link.
 */
export function createPublicLimiter(cfg = publicLimits(), now?: () => number) {
  const limiters = new Map<PublicEndpoint, WindowLimiter>(
    (Object.keys(cfg.perMinute) as PublicEndpoint[]).map((e) => [
      e,
      new WindowLimiter(cfg.perMinute[e], 60_000, now),
    ]),
  );
  /** A 429 response when this request is over its limit, else null. Non-public paths are never limited. */
  return function check(request: NextRequest): NextResponse | null {
    const endpoint = publicEndpointFor(request.nextUrl.pathname);
    if (!endpoint) return null;
    const ip = hashIp(clientIpFromForwardedFor(request.headers.get("x-forwarded-for"), cfg.proxyHops));
    const wait = limiters.get(endpoint)!.hit(ip);
    if (wait === 0) return null;
    return new NextResponse("Too many requests, try again shortly.", {
      status: 429,
      headers: { "retry-after": String(wait), "cache-control": "no-store" },
    });
  };
}

export const checkPublicLimit = createPublicLimiter();
