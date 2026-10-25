import {
  PUBSUB_MAX_BODY_BYTES,
  acceptPubsubPush,
  getIntegration,
  googleJwks,
  type PubsubVerifyConfig,
} from "@opengmb/core";
import type { Db } from "@opengmb/db";

/** Read per request, so a topic or audience saved in the app applies without a restart. */
export function pubsubConfig(jwks: PubsubVerifyConfig["jwks"] = googleJwks()): PubsubVerifyConfig | null {
  const audience = getIntegration("PUBSUB_AUDIENCE");
  const serviceAccountEmail = getIntegration("PUBSUB_SERVICE_ACCOUNT_EMAIL");
  return audience && serviceAccountEmail ? { audience, serviceAccountEmail, jwks } : null;
}

/** Reads at most PUBSUB_MAX_BODY_BYTES; null when the body is larger (the rest is not read). */
async function readCapped(req: Request): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > PUBSUB_MAX_BODY_BYTES) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > PUBSUB_MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Google Pub/Sub push -> us (instant review alerts). Authenticated by the OIDC bearer token Pub/Sub
 * signs, not by cookies. Same implementation as the worker's route (core's acceptPubsubPush);
 * production has no public worker domain, so Pub/Sub pushes to the web app. 204 comes back only
 * after the notification row and its job are committed; anything transient answers 500 so Pub/Sub retries.
 * Response codes match the worker: 503 not configured, 401 bad token, 204 accepted or dropped, 500 transient.
 */
export async function handlePubsubPush(
  req: Request,
  db: Db,
  jwks?: PubsubVerifyConfig["jwks"],
): Promise<Response> {
  try {
    const config = pubsubConfig(jwks);
    const rawBody = config ? await readCapped(req) : null;
    const out = await acceptPubsubPush(db, {
      config,
      authorization: req.headers.get("authorization") ?? undefined,
      rawBody,
      surface: "web",
    });
    return new Response(out.body ? JSON.stringify(out.body) : null, {
      status: out.status,
      headers: {
        ...(out.body ? { "content-type": "application/json" } : {}),
        ...(out.status === 401 ? { "www-authenticate": "Bearer" } : {}),
      },
    });
  } catch (e) {
    console.error("[web] pubsub push failed", e);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
