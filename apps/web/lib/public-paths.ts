// apps/web/lib/public-paths.ts
import { isHostedPublicPath } from "./site-edition";

// Paths reachable without a session: the sign-in flow, the auth API, the health check, the inbound
// callbacks (`/webhooks/dataforseo`, per-task secret in the query; `/webhooks/google-pubsub`, OIDC bearer token),
// public report share links (the page and its PDF), the review
// link redirect, review request email links (`/e/<token>`, `/e/<token>/unsubscribe`), location landing pages
// (`/l/<slug>`, 404 until published), robots.txt, the password reset pages, the web app manifest, service worker
// and icons (fetched without cookies, so they cannot sit behind sign-in), library images (`/m/<token>`, fetched by
// Google), the MCP endpoint (`/mcp`, bearer token, not cookies) and the REST API (`/api/v1/...`, bearer token).
// Pages that only the full server has are added by site-edition.ts. proxy.ts redirects everything else to
// /sign-in when there is no session cookie.
const PUBLIC =
  /^\/(?:api\/auth(?:\/|$)|api\/health$|webhooks\/dataforseo$|webhooks\/google-pubsub$|go\/[a-z0-9][a-z0-9-]{1,59}$|e\/[A-Za-z0-9_-]{43}(?:\/unsubscribe)?$|l\/[a-z0-9][a-z0-9-]{1,59}$|sign-in$|robots\.txt$|forgot-password$|reset-password$|mfa\/verify$|r\/[^/]+(?:\/pdf)?$|m\/[0-9a-f]{48}$|mcp$|api\/v1(?:\/[A-Za-z0-9._%-]+)+$|manifest\.webmanifest$|sw\.js$|icons\/[a-z0-9-]+\.(?:png|svg)$)/;

export function isPublicPath(pathname: string): boolean {
  // "/" is excluded on purpose: proxy.ts serves it as the public home only to signed-out visitors on the main host, and a custom host's signed-out "/" must still go to sign-in.
  return PUBLIC.test(pathname) || isHostedPublicPath(pathname);
}
