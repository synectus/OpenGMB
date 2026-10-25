import { getDb } from "../../../lib/auth";
import { handlePubsubPush } from "../../../lib/pubsub-receiver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Google Pub/Sub push (instant review alerts). Public path (see lib/public-paths.ts), authenticated by the
 * OIDC token in the Authorization header. POST only; Next answers 405 to anything else.
 * Mirrors the worker's route (apps/worker/src/http.ts) through core's acceptPubsubPush.
 */
export async function POST(req: Request) {
  return handlePubsubPush(req, getDb());
}
