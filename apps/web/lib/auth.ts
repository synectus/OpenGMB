import { cache } from "react";
import { nextCookies } from "better-auth/next-js";
import {
  countBackupCodes,
  createAuth,
  getActorContext,
  hasCredentialPassword,
  isGoogleConfigured,
  loadActor,
  viewAsActor,
  type Actor,
} from "@opengmb/core";
import { activeViewAs, type ActiveViewAs } from "@opengmb/core/view-as";
import { createDb } from "@opengmb/db";

// One pool and one auth instance per server process (survives dev hot reloads).
// Built lazily so `next build` does not need a database.
type Instance = { db: ReturnType<typeof createDb>["db"]; auth: ReturnType<typeof createAuth> };
const g = globalThis as unknown as { __syngmb?: Instance };

function instance(): Instance {
  if (!g.__syngmb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const { db } = createDb(url);
    g.__syngmb = { db, auth: createAuth(db, { plugins: [nextCookies()] }) };
  }
  return g.__syngmb;
}

export const getAuth = () => instance().auth;
export const getDb = () => instance().db;
export const googleEnabled = () => isGoogleConfigured();
export const userHasPassword = (userId: string) => hasCredentialPassword(instance().db, userId);

const viewAsOfSession = cache((sessionId: string) => activeViewAs(instance().db, sessionId));

/**
 * AP4: the read-only "view as customer" grant of the current request's session, or null. Always null in the
 * community edition. Memoised per request, so the shell and the actions it runs share one lookup.
 */
export async function currentViewAs(): Promise<ActiveViewAs | null> {
  const { headers } = await import("next/headers");
  const session = await instance().auth.api.getSession({ headers: await headers() });
  return session ? viewAsOfSession(session.session.id) : null;
}

/**
 * The acting person for a signed-in web request, and the ONLY place apps/web builds an actor from a session
 * (apps/web/lib/session-actor.test.ts counts the call sites). While a platform admin is viewing an organization
 * this is that organization's owner view, marked read-only, whatever the admin's own memberships are; otherwise
 * it is the person's own actor.
 */
export async function sessionActor(userId: string): Promise<Actor> {
  const viewing = await currentViewAs();
  if (viewing && viewing.adminUserId === userId) return viewAsActor({ userId, orgId: viewing.orgId });
  return loadActor(instance().db, { userId, surface: "ui", actorType: "user" });
}

/**
 * A 403 for routes that change something with the person's own account (uploads, device registration) while a
 * platform admin is viewing a customer: those routes do not go through the action executor, so the read-only
 * actor cannot stop them. null when nothing is being viewed.
 */
export async function refuseWhileViewing(): Promise<Response | null> {
  if (!(await currentViewAs())) return null;
  return Response.json({ error: "Read-only view: changes are turned off." }, { status: 403, headers: { "cache-control": "no-store" } });
}

export async function actorContextFor(userId: string) {
  return getActorContext(instance().db, await sessionActor(userId));
}

/** Unused backup codes for a signed-in user. Only the number leaves the server. */
export const backupCodesLeft = (userId: string) => countBackupCodes(instance().auth, userId);
