import { NextResponse, type NextRequest } from "next/server";
import {
  AuthError,
  completeGoogleConnection,
  CoreError,
  enqueueNotificationRegistration,
  GoogleOAuthError,
  requireAuthenticatedUser,
} from "@opengmb/core";
import { getAuth, getDb, refuseWhileViewing } from "../../../../lib/auth";

// BETTER_AUTH_URL is the public origin; request.url may be an internal host behind a proxy.
const to = (path: string, request: NextRequest) =>
  NextResponse.redirect(new URL(path, process.env.BETTER_AUTH_URL || request.url));
const failed = (reason: string, request: NextRequest) =>
  to(`/settings/google?error=${encodeURIComponent(reason)}`, request);

/**
 * Google redirects here after consent. The session user (MFA-verified) must be the user who
 * started the flow; completeGoogleConnection enforces that against the stored state.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  // Google reports a declined consent screen as ?error=access_denied.
  if (params.get("error")) return failed("access_denied", request);
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return failed("invalid_state", request);
  if (await refuseWhileViewing()) return failed("read_only", request);

  let userId: string;
  try {
    const session = await getAuth().api.getSession({ headers: request.headers });
    ({ userId } = requireAuthenticatedUser(session));
  } catch (e) {
    if (e instanceof AuthError)
      return to(e.code === "MFA_REQUIRED" ? "/mfa/setup" : "/sign-in", request);
    throw e;
  }

  try {
    const { connectionId } = await completeGoogleConnection(getDb(), {
      stateId: state,
      code,
      sessionUserId: userId,
    });
    // Point this Google account's notifications at our Pub/Sub topic (a worker job; no-op without PUBSUB_TOPIC).
    await enqueueNotificationRegistration(getDb(), { connectionId, scope: "all" });
    return to("/settings/google?connected=1", request);
  } catch (e) {
    if (e instanceof GoogleOAuthError) return failed(e.reason, request);
    if (e instanceof CoreError) return failed(e.code.toLowerCase(), request);
    console.error("[web] google callback failed", e);
    return failed("internal", request);
  }
}
