import { acceptPingback } from "@opengmb/core";
import { getDb } from "../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DataForSEO -> us (rank-grid task pingback). Public path (see lib/public-paths.ts); authenticated by the
 * per-task secret in the query string. Mirrors the worker's handler (apps/worker/src/http.ts): production
 * sets WORKER_PUBLIC_URL to the web app, so pingbacks land here. acceptPingback enqueues the collect job
 * through the DB and the worker picks it up. The body is never read.
 */
async function handle(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const token = url.searchParams.get("token");
  if (!id || !token) return Response.json({ error: "unauthorized" }, { status: 401 });
  const outcome = await acceptPingback(getDb(), { taskRef: id, token });
  if (outcome === "unauthorized") return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ ok: true, duplicate: outcome === "duplicate" });
}

export const GET = handle;
export const POST = handle;
