import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import {
  isAllowedPushEndpoint,
  loadActor,
  pushConfig,
  removePushSubscription,
  requireAuthenticatedUser,
  savePushSubscription,
} from "@opengmb/core";
import { getAuth, getDb } from "../../../../lib/auth";
import { parseSubscriptionBody } from "../../../../lib/push-client";

/**
 * This device's push subscription for the signed-in person (X4). POST stores it, DELETE removes it.
 * 404 when VAPID is not configured, so the feature does not exist on that server.
 */
async function who() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  const { userId } = requireAuthenticatedUser(session);
  const actor = await loadActor(getDb(), { userId, surface: "ui", actorType: "user" });
  return { userId, orgId: actor.orgId };
}

const fail = (status: number, message: string) =>
  NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store" } });

async function handle(request: NextRequest, save: boolean) {
  if (!pushConfig()) return fail(404, "Not found");
  let me;
  try {
    me = await who();
  } catch {
    return fail(401, "Sign in first");
  }
  const body: unknown = await request.json().catch(() => null);
  if (save) {
    const sub = parseSubscriptionBody(body);
    if (!sub || !isAllowedPushEndpoint(sub.endpoint)) return fail(400, "Not a valid subscription");
    await savePushSubscription(getDb(), me, {
      ...sub,
      userAgent: request.headers.get("user-agent"),
    });
  } else {
    const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
    if (typeof endpoint !== "string") return fail(400, "Not a valid subscription");
    await removePushSubscription(getDb(), me, endpoint);
  }
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}

export const POST = (request: NextRequest) => handle(request, true);
export const DELETE = (request: NextRequest) => handle(request, false);
