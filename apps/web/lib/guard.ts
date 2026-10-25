import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError, orgForHost, orgIdsOfUser, requireAuthenticatedUser } from "@opengmb/core";
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
    await keepToMainHost(h, user.userId);
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
