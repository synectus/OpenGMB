"use server";
import { headers } from "next/headers";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { approveConnection, clearOrgChoice, connectableOrgs, oauthClientName, rememberOrgChoice } from "@opengmb/core";
import { getAuth, getDb } from "../../../lib/auth";
import { parseConsentChoice, redirectHostOf } from "../../../lib/oauth-consent";

export type ConsentResult = { ok: true; url: string } | { ok: false; error: "expired" | "noAccount" | "failed" };

async function context(oauthQuery: string) {
  const auth = getAuth();
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session) return null;
  if (!(await verifyOAuthQueryParams(oauthQuery, process.env.BETTER_AUTH_SECRET!))) return null;
  return { auth, h, session };
}

async function finish(auth: ReturnType<typeof getAuth>, h: Headers, sessionId: string, oauthQuery: string, accept: boolean): Promise<ConsentResult> {
  try {
    // The plugin runs the authorize step inside consent, which refuses a call with no request ("request not found"),
    // and without asResponse the in-process call returns {} and drops the redirect URL (Phase 0 spike, 2026-11-10).
    const res = (await auth.api.oauth2Consent({
      headers: h,
      request: new Request(`${process.env.BETTER_AUTH_URL}/api/auth/oauth2/consent`, { method: "POST", headers: h }),
      body: { accept, oauth_query: oauthQuery },
      asResponse: true,
    })) as Response;
    const out = (await res.json().catch(() => null)) as { url?: string } | null;
    return res.ok && out?.url ? { ok: true, url: out.url } : { ok: false, error: "failed" };
  } finally {
    await clearOrgChoice(getDb(), sessionId);
  }
}

export async function approveConsent(oauthQuery: string, form: { orgId?: string; access?: string; fullAutonomy?: boolean }): Promise<ConsentResult> {
  const c = await context(oauthQuery);
  if (!c) return { ok: false, error: "expired" };
  const db = getDb();
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get("client_id");
  const redirectHost = redirectHostOf(params.get("redirect_uri"));
  const client = clientId ? await oauthClientName(db, clientId) : null;
  if (!clientId || !client || !redirectHost) return { ok: false, error: "failed" };
  const choice = parseConsentChoice(form, await connectableOrgs(db, c.session.user.id));
  if ("error" in choice) return { ok: false, error: "noAccount" };
  // The row first: if consent then fails, the person sees an unused connection they can disconnect, never a token without a row.
  await approveConnection(db, { userId: c.session.user.id, clientId, clientName: client.name ?? redirectHost, redirectHost, ...choice });
  // Always stored, one organization or many: the consent hook (oauth/provider.ts) refuses accept without a stored choice.
  await rememberOrgChoice(db, c.session.session.id, choice.orgId);
  return finish(c.auth, c.h, c.session.session.id, oauthQuery, true);
}

export async function denyConsent(oauthQuery: string): Promise<ConsentResult> {
  const c = await context(oauthQuery);
  if (!c) return { ok: false, error: "expired" };
  return finish(c.auth, c.h, c.session.session.id, oauthQuery, false);
}
