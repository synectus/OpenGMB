import { CSP_EXTRA_HOSTS } from "./site-edition";

/**
 * Response headers for every route. Nothing in the app is meant to be framed (the review widget is
 * a script plus JSON, not an iframe), so framing is refused outright: a page that approves or
 * publishes things must not be clickjackable. Referrers stay on this origin because share and
 * invite links carry their secret in the path. The static Content-Security-Policy below only
 * refuses framing, so it also covers responses the proxy does not touch; the full per-request,
 * nonce-based policy is built by buildCsp and set from proxy.ts.
 */
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/**
 * The full Content-Security-Policy for one request. Scripts: only Next's own bundles and inline
 * bootstrap scripts, which carry this request's nonce (Next reads it from the request's CSP
 * header), plus whatever those load ('strict-dynamic', which is how the Google Maps script gets
 * in). Styles: files from this origin and inline <style> tags that carry the nonce. Narrower
 * than ideal in two places, both on purpose: style attributes stay allowed (React `style={...}`
 * for progress bars and brand colours cannot carry a nonce), and images may come from any https
 * origin (agency logos, Google photos). Development needs 'unsafe-eval' and inline styles for
 * hot reload; production never gets them.
 */
export function buildCsp(nonce: string, dev: boolean): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // fonts.googleapis.com: the Maps API's stylesheet.
    `style-src 'self' https://fonts.googleapis.com ${dev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' https://fonts.gstatic.com",
    // The origins Google's CSP guide for the Maps JavaScript API lists (rank map).
    // Extra hosts the full server's payment checkout needs (site-edition.ts); the community edition adds none.
    `connect-src 'self' https://*.googleapis.com https://*.google.com https://*.gstatic.com ${[...CSP_EXTRA_HOSTS.connect, "data:", "blob:"].join(" ")}`,
    ...(CSP_EXTRA_HOSTS.frame.length ? [`frame-src ${CSP_EXTRA_HOSTS.frame.join(" ")}`] : []),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return directives.join("; ");
}
