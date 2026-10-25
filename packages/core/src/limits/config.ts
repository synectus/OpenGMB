import { REVIEW_LINK_TOOL } from "../config/review-link-tool";
import { intFromEnv } from "./window";

type Env = Record<string, string | undefined>;

/**
 * Per-account sign-in lockout (H1a). Our own conservative choices, not external numbers: this many
 * wrong passwords for one email address inside the window refuses further sign-ins for that
 * address until the window ends (time-based, never a permanent lock). The per-IP sign-in limit
 * (AUTH_RATE_LIMIT_RULES) still applies on top.
 */
export function lockoutConfig(env: Env = process.env) {
  return {
    failures: intFromEnv("AUTH_LOCKOUT_FAILURES", 10, env),
    windowMinutes: intFromEnv("AUTH_LOCKOUT_MINUTES", 15, env),
  };
}

/**
 * Per-IP requests per minute on the public, no-login endpoints. A visitor opening a share link,
 * review link, the widget or a library image is one request each, so these are far above human use.
 * `/m/` is higher because Google fetches several images in a burst from few addresses.
 * `tools-search` is the review link generator's business search (POST /api/tools/review-link/search), which calls Google per press; `/api/tools/review-link/qr` is in `tools`.
 * `tools` is the free checkers (POST /api/tools/check): 20 a minute is far above a person pasting text, and each call runs the rule engine on up to 20,000 characters.
 */
export const PUBLIC_ENDPOINTS = ["share", "review-link", "widget", "image", "help", "status", "tools", "tools-search"] as const;
export type PublicEndpoint = (typeof PUBLIC_ENDPOINTS)[number];

export function publicLimits(env: Env = process.env) {
  return {
    perMinute: {
      share: intFromEnv("PUBLIC_SHARE_PER_MINUTE", 60, env),
      "review-link": intFromEnv("PUBLIC_REVIEW_LINK_PER_MINUTE", 60, env),
      widget: intFromEnv("PUBLIC_WIDGET_PER_MINUTE", 120, env),
      image: intFromEnv("PUBLIC_IMAGE_PER_MINUTE", 300, env),
      help: intFromEnv("PUBLIC_HELP_PER_MINUTE", 120, env),
      status: intFromEnv("PUBLIC_STATUS_PER_MINUTE", 30, env),
      tools: intFromEnv("PUBLIC_TOOLS_PER_MINUTE", 20, env),
      "tools-search": intFromEnv("PUBLIC_TOOLS_SEARCH_PER_MINUTE", REVIEW_LINK_TOOL.perIpPerMinute, env),
    } satisfies Record<PublicEndpoint, number>,
    /** Reverse proxies in front of the web app (a Traefik proxy is 1). */
    proxyHops: intFromEnv("WEB_PROXY_HOPS", 1, env),
  };
}

/** Which public endpoint a path is, or null for everything else. Matches public-paths.ts. */
export function publicEndpointFor(pathname: string): PublicEndpoint | null {
  if (/^\/r\/[^/]+(?:\/pdf)?$/.test(pathname)) return "share";
  if (/^\/go\/[^/]+$/.test(pathname)) return "review-link";
  if (/^\/api\/widget\/[^/]+$/.test(pathname)) return "widget";
  // Location landing pages (X3) share the widget's bucket: public, cacheable, same traffic shape.
  if (/^\/l\/[^/]+$/.test(pathname)) return "widget";
  if (/^\/m\/[^/]+$/.test(pathname)) return "image";
  if (/^\/help(?:\/[^/]+)?$/.test(pathname)) return "help";
  if (pathname === "/status") return "status";
  if (pathname === "/api/tools/check" || pathname === "/api/tools/review-link/qr") return "tools";
  if (pathname === "/api/tools/review-link/search") return "tools-search";
  return null;
}
