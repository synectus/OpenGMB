import { request } from "node:https";
import { and, eq, sql } from "drizzle-orm";
import { apiTokens, memberships, webhookDeliveries, webhookSubscriptions, type Db, type Tx } from "@opengmb/db";
import { writeAudit } from "../audit";
import {
  WEBHOOK_DISABLE_AFTER_FAILURES,
  WEBHOOK_LAST_ERROR_MAX_CHARS,
  WEBHOOK_MAX_RESPONSE_BYTES,
  WEBHOOK_TIMEOUT_MS,
} from "../config/webhooks";
import { signWebhook } from "./signing";
import { webhookSecretOf } from "./subscriptions";
import { guardedLookup, validateWebhookUrl, type LookupPolicy, type Resolver } from "./ssrf";

/** Test-only dependencies. The worker passes only `isFinalAttempt`. */
export type DeliverDeps = {
  isFinalAttempt?: boolean;
  policy?: LookupPolicy;
  /** Used to validate the URL before connecting. */
  resolve?: Resolver;
  /** Used by the connection's own lookup; defaults to `resolve`. A different answer simulates DNS rebinding. */
  lookupResolve?: Resolver;
  /** Extra CA for a self-signed test receiver. */
  ca?: string | Buffer;
  timeoutMs?: number;
  now?: () => Date;
};

export type SendResult =
  | { kind: "response"; statusCode: number; bytesRead: number; truncated: boolean }
  | { kind: "error"; code: "timeout" | "blocked_address" | "dns" | "tls" | "network" };

/**
 * One POST. No redirects are followed (a 3xx is simply a status code), the whole attempt is cut at
 * `timeoutMs`, and at most WEBHOOK_MAX_RESPONSE_BYTES of the response are read before the socket is
 * dropped. The connection's `lookup` is the SSRF guard: the address checked is the address used.
 */
export function sendWebhookRequest(
  url: URL,
  input: { headers: Record<string, string>; body: string },
  opts: { policy?: LookupPolicy; resolve?: Resolver; ca?: string | Buffer; timeoutMs?: number } = {},
): Promise<SendResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: SendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(r);
    };
    const req = request(url, {
      method: "POST",
      agent: false,
      headers: { ...input.headers, "content-length": String(Buffer.byteLength(input.body)) },
      lookup: guardedLookup(opts.policy, opts.resolve) as never,
      ...(opts.ca ? { ca: opts.ca } : {}),
    });
    const timer = setTimeout(() => done({ kind: "error", code: "timeout" }), opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
    req.on("error", (e: NodeJS.ErrnoException) => {
      const code = e.code ?? "";
      done({
        kind: "error",
        code:
          code === "WEBHOOK_BLOCKED_ADDRESS"
            ? "blocked_address"
            : code === "ENOTFOUND" || code === "EAI_AGAIN"
              ? "dns"
              : /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|UNABLE_TO|SELF_SIGNED|ERR_OSSL)/.test(code)
                ? "tls"
                : "network",
      });
    });
    req.on("response", (res) => {
      let bytes = 0;
      const finish = (truncated: boolean) =>
        done({ kind: "response", statusCode: res.statusCode ?? 0, bytesRead: bytes, truncated });
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes >= WEBHOOK_MAX_RESPONSE_BYTES) {
          bytes = WEBHOOK_MAX_RESPONSE_BYTES;
          finish(true);
        }
      });
      res.on("end", () => finish(false));
      res.on("error", () => finish(false));
    });
    req.end(input.body);
  });
}

type Outcome = "delivered" | "failed" | "skipped";

async function disable(
  tx: Tx,
  sub: { id: string; orgId: string },
  reason: "gone" | "failing" | "token_revoked" | "creator_removed",
) {
  await tx
    .update(webhookSubscriptions)
    .set({ status: "disabled", disabledReason: reason, updatedAt: new Date() })
    .where(and(eq(webhookSubscriptions.id, sub.id), eq(webhookSubscriptions.status, "active")));
  await writeAudit(tx, {
    orgId: sub.orgId,
    actorUserId: null,
    actorType: "system",
    surface: "worker",
    action: "webhook.disabled",
    entityType: "webhook_subscription",
    entityId: sub.id,
    after: { reason },
  });
}

const clip = (s: string) => s.slice(0, WEBHOOK_LAST_ERROR_MAX_CHARS);

/**
 * Worker side of `webhook.deliver`. Reads the delivery, re-checks the subscription's owner and
 * URL, sends with no transaction open, then settles in one short transaction. A retryable failure
 * (network error, timeout, 408, 429, 5xx) throws so pg-boss retries, unless `isFinalAttempt`.
 * Returns null when the delivery is gone or already settled.
 */
export async function processWebhookDelivery(
  db: Db,
  deliveryId: string,
  deps: DeliverDeps = {},
): Promise<Outcome | null> {
  const [row] = await db
    .select({ d: webhookDeliveries, s: webhookSubscriptions })
    .from(webhookDeliveries)
    .innerJoin(webhookSubscriptions, eq(webhookSubscriptions.id, webhookDeliveries.subscriptionId))
    .where(eq(webhookDeliveries.id, deliveryId));
  if (!row || row.d.status !== "pending") return null;
  const { d, s } = row;
  const now = deps.now ?? (() => new Date());

  const settle = (
    tx: Tx,
    set: Partial<typeof webhookDeliveries.$inferInsert>,
  ) =>
    tx
      .update(webhookDeliveries)
      .set(set)
      .where(and(eq(webhookDeliveries.id, d.id), eq(webhookDeliveries.status, "pending")))
      .returning({ id: webhookDeliveries.id });

  // Owner re-check: nothing is sent for a revoked token or a removed creator.
  const ownerGone = await (async () => {
    if (s.apiTokenId) {
      const [t] = await db
        .select({ revokedAt: apiTokens.revokedAt })
        .from(apiTokens)
        .where(eq(apiTokens.id, s.apiTokenId));
      if (!t || t.revokedAt) return "token_revoked" as const;
    }
    const [m] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, s.createdByUserId), eq(memberships.orgId, s.orgId)))
      .limit(1);
    return m ? null : ("creator_removed" as const);
  })();
  if (s.status !== "active" || ownerGone) {
    await db.transaction(async (tx) => {
      const [settled] = await settle(tx, { status: "skipped", lastError: s.status !== "active" ? "subscription_disabled" : ownerGone });
      if (settled && s.status === "active" && ownerGone) await disable(tx, s, ownerGone);
    });
    return "skipped";
  }

  const check = await validateWebhookUrl(s.url, { resolve: deps.resolve, policy: deps.policy });
  let result: SendResult;
  if (!check.ok) {
    result = { kind: "error", code: check.reason === "dns" ? "dns" : "blocked_address" };
  } else {
    const body = JSON.stringify(d.payload);
    const timestamp = Math.floor(now().getTime() / 1000);
    result = await sendWebhookRequest(
      check.url,
      {
        body,
        headers: {
          "content-type": "application/json",
          "user-agent": "OpenGMB-Webhooks/1",
          "webhook-id": d.id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signWebhook({ id: d.id, timestamp, body, secret: webhookSecretOf(s) }),
        },
      },
      {
        policy: deps.policy,
        resolve: deps.lookupResolve ?? deps.resolve,
        ca: deps.ca,
        timeoutMs: deps.timeoutMs,
      },
    );
  }

  const code = result.kind === "response" ? result.statusCode : null;
  const error = result.kind === "error" ? result.code : code !== null && (code < 200 || code >= 300) ? `http_${code}` : null;
  const attempts = d.attempts + 1;

  if (result.kind === "response" && code! >= 200 && code! < 300) {
    await db.transaction(async (tx) => {
      const settled = await settle(tx, { status: "delivered", attempts, lastStatusCode: code, lastError: null, deliveredAt: now() });
      if (settled.length > 0) {
        await tx
          .update(webhookSubscriptions)
          .set({ consecutiveFailures: 0 })
          .where(eq(webhookSubscriptions.id, s.id));
      }
    });
    return "delivered";
  }

  const retryable =
    result.kind === "error"
      ? result.code !== "blocked_address"
      : code === 408 || code === 429 || code! >= 500;
  if (retryable && !deps.isFinalAttempt) {
    await db
      .update(webhookDeliveries)
      .set({ attempts, lastStatusCode: code, lastError: clip(error!) })
      .where(and(eq(webhookDeliveries.id, d.id), eq(webhookDeliveries.status, "pending")));
    throw new Error(`webhook delivery ${d.id} will be retried (${error})`);
  }

  await db.transaction(async (tx) => {
    const settled = await settle(tx, { status: "failed", attempts, lastStatusCode: code, lastError: clip(error!) });
    if (settled.length === 0) return;
    if (code === 410) {
      await disable(tx, s, "gone");
      return;
    }
    const [updated] = await tx
      .update(webhookSubscriptions)
      .set({ consecutiveFailures: sql`${webhookSubscriptions.consecutiveFailures} + 1` })
      .where(eq(webhookSubscriptions.id, s.id))
      .returning({ n: webhookSubscriptions.consecutiveFailures });
    if (updated && updated.n >= WEBHOOK_DISABLE_AFTER_FAILURES) await disable(tx, s, "failing");
  });
  return "failed";
}
