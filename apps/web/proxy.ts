import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { isPublicPath } from "./lib/public-paths";
import { checkPublicLimit } from "./lib/public-limits";
import { buildCsp } from "./lib/security-headers";
import { PUBLIC_HOME_PATH } from "./lib/public-home";
import { isMainHost, isProductSitePath, requestHost } from "./lib/request-host";
import { shouldNoindex, stagingGate } from "./lib/site-edition";

// Cheap optimistic check only: cookie presence. The real decision (session validity,
// idle/absolute expiry, MFA) is made by requireAuthenticatedUser in the server layouts/pages.
export function proxy(request: NextRequest) {
  const gated = stagingGate(request);
  if (gated) return gated;
  // The MCP endpoint and the REST API (/api/v1/...) authenticate by bearer token (checked by the MCP
  // service), not by cookie, and answer JSON: no sign-in redirect, no CSP nonce, never indexed.
  if (request.nextUrl.pathname === "/mcp" || request.nextUrl.pathname.startsWith("/api/v1/")) {
    const mcp = NextResponse.next();
    mcp.headers.set("X-Robots-Tag", "noindex");
    return mcp;
  }
  const limited = checkPublicLimit(request);
  if (limited) return limited;
  const signedOut = !getSessionCookie(request);
  // A custom host (an agency's own address) is not a second copy of the product site: no marketing
  // pages, and signed-out "/" is the sign-in page.
  const customHost = !isMainHost(requestHost(request.headers));
  if (customHost && isProductSitePath(request.nextUrl.pathname)) {
    return new NextResponse("Not found", { status: 404 });
  }
  // "/" is the app home for signed-in people and the public product page for everyone else.
  const publicHomePath = request.nextUrl.pathname === "/" && signedOut && !customHost ? PUBLIC_HOME_PATH : null;
  const publicHome = publicHomePath !== null;
  if (!publicHome && !isPublicPath(request.nextUrl.pathname) && signedOut) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }
  // A fresh nonce per request. Next reads the policy from the request headers and stamps the nonce
  // on its own scripts; x-nonce is for our inline <style> tags (components/nonce-style.tsx).
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, process.env.NODE_ENV !== "production");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Server components cannot see the path: guard.ts needs it to send a visitor to the same page on the main host.
  requestHeaders.set("x-pathname", request.nextUrl.pathname + request.nextUrl.search);
  requestHeaders.set("content-security-policy", csp);
  const init = { request: { headers: requestHeaders } };
  const response = publicHomePath ? NextResponse.rewrite(new URL(publicHomePath, request.url), init) : NextResponse.next(init);
  response.headers.set("content-security-policy", csp);
  // Only live marketing pages (and the listed public exceptions) may be indexed. Google never has the session cookie, so a signed-in "/" is the app home and stays out of the index.
  if (shouldNoindex(request.nextUrl.pathname) || (request.nextUrl.pathname === "/" && !signedOut)) response.headers.set("X-Robots-Tag", "noindex");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico$).*)"],
};
