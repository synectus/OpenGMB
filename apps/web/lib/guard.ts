import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError, orgForHost, orgIdsOfUser, requireAuthenticatedUser } from "@opengmb/core";
import { isUserBlocked } from "@opengmb/core/account-state";
import { touchUserActive } from "@opengmb/core/admin-capture";
import { getAuth, getDb } from "./auth";
import { hostAllowsOrg, isMainHost, requestHost } from "./request-host";

/**
 * Server-side gate for protected pages. The decision comes from core's
 * requireAuthenticatedUser; this only maps its outcome to a redirect.
 */
export async function requireUser() {
  const h = await headers(); // first, so the route is opted into dynamic rendering
  const session = await getAuth().api.getSession({ headers: h });
  try {
    const user = requireAuthenticatedUser(session);
    // AP3b: suspending an account or turning a person's sign-in off ends their sessions at once; this catches a session
    // that slipped through (one created a moment before) and must not be used. Always false in the community edition.
    if (await isUserBlocked(getDb(), user.userId)) {
      redirect("/sign-in?blocked=1");
    }
    await keepToMainHost(h, user.userId);
    // AP1b: a stand-in no-op in the community edition. Swallows its own errors; throttled to one write per user per 15 minutes.
    await touchUserActive(getDb(), user.userId);
    return user;
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "MFA_REQUIRED" ? "/mfa/setup" : "/sign-in");
    throw e;
  }
}

/**
 * On an agency's own address, only that agency's people may use the app. Anyone else (another
 * organization's user, or a host we no longer know) is sent to the same page on the main host.
 */
async function keepToMainHost(h: Headers, userId: string): Promise<void> {
  const host = requestHost(h);
  if (isMainHost(host)) return;
  const db = getDb();
  const hostOrgId = await orgForHost(db, host!);
  if (hostAllowsOrg(hostOrgId, await orgIdsOfUser(db, userId), false)) return;
  const base = process.env.BETTER_AUTH_URL;
  if (base) redirect(new URL(h.get("x-pathname") ?? "/", base).toString());
}
