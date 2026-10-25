import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { webhookDeliveries, webhookSubscriptions, workspaces, type Tx } from "@opengmb/db";
import { AccessError, authorize, type Actor } from "../actor";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_MAX_ACTIVE_PER_ORG,
  WEBHOOK_QUEUE,
  type WebhookEvent,
} from "../config/webhooks";
import { decryptSecret, encryptSecret } from "../crypto";
import { CoreError } from "../errors";
import { enqueueJob } from "../jobs";
import type { ActionAuditEntry } from "../registry";
import { sampleReviewCreatedPayload } from "./payload";
import { generateWebhookSecret } from "./signing";
import { validateWebhookUrl, type LookupPolicy, type Resolver } from "./ssrf";

type AuditFn = (entry: ActionAuditEntry) => Promise<void>;
/** Test-only dependencies. The registered actions pass none, so production always uses real DNS and no relaxation. */
export type SubscribeDeps = { policy?: LookupPolicy; resolve?: Resolver };

const URL_REASON: Record<string, string> = {
  invalid_url: "That is not a valid URL.",
  scheme: "The URL must start with https://.",
  userinfo: "The URL must not contain a username or password.",
  port: "Only the standard https port (443) is allowed.",
  blocked_address: "That address is private or not allowed.",
  dns: "That host name could not be resolved.",
};

export type SubscriptionView = {
  id: string;
  url: string;
  events: string[];
  workspaceId: string | null;
  description: string | null;
  status: "active" | "disabled";
  disabledReason: string | null;
  consecutiveFailures: number;
  createdAt: string;
  lastDelivery: {
    status: string;
    statusCode: number | null;
    at: string;
    test: boolean;
  } | null;
};

type SubRow = typeof webhookSubscriptions.$inferSelect;

/** The public shape of a row. The signing secret is never part of it. */
function view(row: SubRow, last: SubscriptionView["lastDelivery"] = null): SubscriptionView {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    workspaceId: row.workspaceId,
    description: row.description,
    status: row.status,
    disabledReason: row.disabledReason,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt.toISOString(),
    lastDelivery: last,
  };
}

/** Audit rows carry the host and ids only: a webhook URL path can itself be a secret. */
const auditShape = (row: SubRow) => ({
  host: new URL(row.url).host,
  events: row.events,
  workspaceId: row.workspaceId,
  status: row.status,
  disabledReason: row.disabledReason,
});

async function lockOrg(tx: Tx, orgId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"webhook_subscriptions:" + orgId}, 0))`);
}

async function activeCount(tx: Tx, orgId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.orgId, orgId), eq(webhookSubscriptions.status, "active")));
  return r?.n ?? 0;
}

async function load(tx: Tx, actor: Actor, id: string): Promise<SubRow> {
  const [row] = await tx.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
  // Another org's subscription looks exactly like a missing one.
  if (!row || row.orgId !== actor.orgId) throw new AccessError("NOT_FOUND", "Webhook not found");
  if (row.workspaceId && actor.workspaceIds !== "all" && !actor.workspaceIds.includes(row.workspaceId)) {
    throw new AccessError("NOT_FOUND", "Webhook not found");
  }
  return row;
}

export async function checkWebhookUrl(raw: string, deps: SubscribeDeps = {}): Promise<URL> {
  const r = await validateWebhookUrl(raw, deps);
  if (!r.ok) throw new CoreError("INVALID_INPUT", URL_REASON[r.reason] ?? "That URL is not allowed.");
  return r.url;
}

export async function subscribeWebhook(
  tx: Tx,
  actor: Actor,
  input: { url: string; events?: WebhookEvent[]; workspaceId?: string; description?: string },
  audit: AuditFn,
  deps: SubscribeDeps = {},
): Promise<{ subscription: SubscriptionView; secret: string }> {
  authorize(actor, "webhook:manage", input.workspaceId ? { workspaceId: input.workspaceId } : {});
  if (input.workspaceId) {
    const [w] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.orgId, actor.orgId)));
    if (!w) throw new AccessError("FORBIDDEN", "Workspace outside actor scope");
  }
  const url = await checkWebhookUrl(input.url, deps);
  await lockOrg(tx, actor.orgId);
  if ((await activeCount(tx, actor.orgId)) >= WEBHOOK_MAX_ACTIVE_PER_ORG) {
    throw new CoreError(
      "CONFLICT",
      `At most ${WEBHOOK_MAX_ACTIVE_PER_ORG} webhooks can be active. Delete or turn one off first.`,
    );
  }
  const secret = generateWebhookSecret();
  const [row] = await tx
    .insert(webhookSubscriptions)
    .values({
      orgId: actor.orgId,
      workspaceId: input.workspaceId ?? null,
      url: url.href,
      events: input.events ?? [...WEBHOOK_EVENTS],
      secretEnc: encryptSecret(secret),
      description: input.description ?? null,
      createdByUserId: actor.userId,
      apiTokenId: actor.apiTokenId ?? null,
    })
    .returning();
  await audit({
    action: "webhook.subscribe",
    entityType: "webhook_subscription",
    entityId: row!.id,
    before: null,
    after: auditShape(row!),
  });
  return { subscription: view(row!), secret };
}

export async function listWebhooks(tx: Tx, actor: Actor): Promise<SubscriptionView[]> {
  authorize(actor, "webhook:manage");
  const rows = await tx
    .select()
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.orgId, actor.orgId),
        actor.workspaceIds === "all"
          ? undefined
          : or(
              isNull(webhookSubscriptions.workspaceId),
              inArray(webhookSubscriptions.workspaceId, actor.workspaceIds),
            ),
      ),
    )
    .orderBy(desc(webhookSubscriptions.createdAt));
  if (rows.length === 0) return [];
  const last = await tx
    .selectDistinctOn([webhookDeliveries.subscriptionId], {
      subscriptionId: webhookDeliveries.subscriptionId,
      status: webhookDeliveries.status,
      statusCode: webhookDeliveries.lastStatusCode,
      test: webhookDeliveries.test,
      at: webhookDeliveries.createdAt,
    })
    .from(webhookDeliveries)
    .where(inArray(webhookDeliveries.subscriptionId, rows.map((r) => r.id)))
    .orderBy(webhookDeliveries.subscriptionId, desc(webhookDeliveries.createdAt));
  const byId = new Map(last.map((l) => [l.subscriptionId, l]));
  return rows.map((r) => {
    const l = byId.get(r.id);
    return view(r, l ? { status: l.status, statusCode: l.statusCode, at: l.at.toISOString(), test: l.test } : null);
  });
}

export async function unsubscribeWebhook(tx: Tx, actor: Actor, id: string, audit: AuditFn) {
  authorize(actor, "webhook:manage");
  const row = await load(tx, actor, id);
  await tx.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
  await audit({
    action: "webhook.unsubscribe",
    entityType: "webhook_subscription",
    entityId: id,
    before: auditShape(row),
    after: null,
  });
  return { id };
}

export async function setWebhookStatus(
  tx: Tx,
  actor: Actor,
  input: { id: string; status: "active" | "disabled" },
  audit: AuditFn,
): Promise<SubscriptionView> {
  authorize(actor, "webhook:manage");
  await lockOrg(tx, actor.orgId);
  const row = await load(tx, actor, input.id);
  if (input.status === "active" && row.status !== "active") {
    if ((await activeCount(tx, actor.orgId)) >= WEBHOOK_MAX_ACTIVE_PER_ORG) {
      throw new CoreError("CONFLICT", `At most ${WEBHOOK_MAX_ACTIVE_PER_ORG} webhooks can be active.`);
    }
  }
  const [updated] = await tx
    .update(webhookSubscriptions)
    .set(
      input.status === "active"
        ? { status: "active", disabledReason: null, consecutiveFailures: 0, updatedAt: new Date() }
        : { status: "disabled", disabledReason: "manual", updatedAt: new Date() },
    )
    .where(eq(webhookSubscriptions.id, row.id))
    .returning();
  await audit({
    action: "webhook.set_status",
    entityType: "webhook_subscription",
    entityId: row.id,
    before: auditShape(row),
    after: auditShape(updated!),
  });
  return view(updated!);
}

const DELIVERY_LIST_LIMIT = 50;

export async function listWebhookDeliveries(tx: Tx, actor: Actor, id: string) {
  authorize(actor, "webhook:manage");
  await load(tx, actor, id);
  const rows = await tx
    .select({
      id: webhookDeliveries.id,
      eventType: webhookDeliveries.eventType,
      test: webhookDeliveries.test,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      lastStatusCode: webhookDeliveries.lastStatusCode,
      lastError: webhookDeliveries.lastError,
      createdAt: webhookDeliveries.createdAt,
      deliveredAt: webhookDeliveries.deliveredAt,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.subscriptionId, id))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(DELIVERY_LIST_LIMIT);
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    deliveredAt: r.deliveredAt?.toISOString() ?? null,
  }));
}

/** Queues one `test: true` delivery with a sample payload; the worker sends it like any other. */
export async function queueTestWebhook(tx: Tx, actor: Actor, id: string, audit: AuditFn) {
  authorize(actor, "webhook:manage");
  const row = await load(tx, actor, id);
  if (row.status !== "active") throw new CoreError("CONFLICT", "Turn the webhook on before sending a test.");
  const [ws] = await tx
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(
      row.workspaceId
        ? eq(workspaces.id, row.workspaceId)
        : and(
            eq(workspaces.orgId, actor.orgId),
            actor.workspaceIds === "all" ? undefined : inArray(workspaces.id, actor.workspaceIds),
          ),
    )
    .orderBy(workspaces.createdAt)
    .limit(1);
  if (!ws) throw new CoreError("CONFLICT", "There is no client to build a sample event from.");
  const entityId = crypto.randomUUID();
  const [delivery] = await tx
    .insert(webhookDeliveries)
    .values({
      orgId: actor.orgId,
      workspaceId: ws.id,
      subscriptionId: row.id,
      eventType: "review.created",
      entityId,
      payload: sampleReviewCreatedPayload(ws),
      test: true,
    })
    .returning({ id: webhookDeliveries.id });
  await enqueueJob(tx, WEBHOOK_QUEUE, { deliveryId: delivery!.id });
  await audit({
    action: "webhook.test_queued",
    entityType: "webhook_subscription",
    entityId: row.id,
    before: null,
    after: { deliveryId: delivery!.id },
  });
  return { deliveryId: delivery!.id };
}

/** Worker side: the plaintext secret, decrypted. Never exposed through an action. */
export const webhookSecretOf = (row: Pick<SubRow, "secretEnc">) => decryptSecret(row.secretEnc);
