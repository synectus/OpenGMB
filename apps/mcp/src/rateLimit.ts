import type { IncomingMessage } from "node:http";
import { WindowLimiter, clientIpFromForwardedFor, intFromEnv } from "@opengmb/core/limits";

export { WindowLimiter };

export type McpRateLimits = {
  /** Invalid or missing bearer tokens per IP per minute before that IP is refused outright. */
  authFailuresPerMinute: number;
  /** Authenticated requests per token per minute. */
  requestsPerMinute: number;
  /** How many reverse proxies sit in front (a Traefik proxy is 1): the client IP is that far from the right of X-Forwarded-For. */
  proxyHops: number;
  now?: () => number;
};

export function rateLimitsFromEnv(): McpRateLimits {
  return {
    authFailuresPerMinute: intFromEnv("MCP_AUTH_FAILURES_PER_MINUTE", 10),
    requestsPerMinute: intFromEnv("MCP_REQUESTS_PER_MINUTE", 300),
    proxyHops: intFromEnv("MCP_PROXY_HOPS", 1),
  };
}

/** The caller's address; see clientIpFromForwardedFor. */
export function clientIp(req: IncomingMessage, proxyHops: number): string {
  return clientIpFromForwardedFor(
    req.headers["x-forwarded-for"],
    proxyHops,
    req.socket.remoteAddress,
  );
}

export function createMcpLimiters(cfg: McpRateLimits) {
  return {
    cfg,
    authFailures: new WindowLimiter(cfg.authFailuresPerMinute, 60_000, cfg.now),
    requests: new WindowLimiter(cfg.requestsPerMinute, 60_000, cfg.now),
  };
}
