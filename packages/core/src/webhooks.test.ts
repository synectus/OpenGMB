import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import { createDb, reviews, webhookDeliveries, webhookSubscriptions } from "@opengmb/db";
import type { Actor } from "./actor";
import { decryptSecret } from "./crypto";
import { WEBHOOK_DELIVERY_RETENTION_DAYS, WEBHOOK_MAX_ACTIVE_PER_ORG, WEBHOOK_QUEUE } from "./config/webhooks";
import { purgeOldWebhookDeliveries } from "./webhooks/purge";
import { MockGoogleClient } from "./google/mock-client";
import { roleHasPermission } from "./permissions";
import { codeOf, makeKit } from "./testkit";
import { buildReviewCreatedEvents, reviewCreatedPayload } from "./webhooks/payload";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(async () => {
  await kit.deactivateAll();
  await client.end();
});
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const boss = new PgBoss(url);
beforeAll(async () => {
  await boss.start();
  await boss.createQueue(WEBHOOK_QUEUE);
  await boss.stop();
});

describe("webhook:manage permission", () => {
  it("is held by owner and admin only", () => {
    expect(roleHasPermission("owner", "webhook:manage")).toBe(true);
    expect(roleHasPermission("admin", "webhook:manage")).toBe(true);
    for (const r of ["manager", "client_approver", "client_viewer"] as const) {
      expect(roleHasPermission(r, "webhook:manage")).toBe(false);
    }
  });
});

describe("review.created payload", () => {
  it("builds the payload for a seeded review and matches the v1 schema", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const createTime = new Date("2026-10-20T10:00:00Z");
    const [r] = await db
      .insert(reviews)
      .values({
        orgId: org.orgId,
        workspaceId: org.a,
        locationId: loc.row.id,
        googleReviewName: `${loc.parent}/reviews/p1-${Math.random()}`,
        reviewerDisplayName: "Pat Reviewer",
        starRating: 4,
        comment: "Great service",
        createTime,
        updateTime: createTime,
      })
      .returning();
    const [anon] = await db
      .insert(reviews)
      .values({
        orgId: org.orgId,
        workspaceId: org.a,
        locationId: loc.row.id,
        googleReviewName: `${loc.parent}/reviews/p2-${Math.random()}`,
        reviewerDisplayName: "A Google User",
        reviewerIsAnonymous: true,
        createTime,
        updateTime: createTime,
      })
      .returning();
    const built = await db.transaction((tx) => buildReviewCreatedEvents(tx, [r!.id, anon!.id], new Date("2026-10-21T00:00:00Z")));
    expect(built).toHaveLength(2);
    for (const p of built) expect(reviewCreatedPayload.safeParse(p.payload).success).toBe(true);
    const byId = new Map(built.map((b) => [b.reviewId, b]));
    const p = byId.get(r!.id)!;
    expect(p.workspaceId).toBe(org.a);
    expect(p.payload).toMatchObject({
      type: "review.created",
      test: false,
      createdAt: "2026-10-21T00:00:00.000Z",
      data: {
        review: {
          id: r!.id,
          workspaceId: org.a,
          workspaceName: "A",
          locationId: loc.row.id,
          locationName: loc.row.name,
          starRating: 4,
          comment: "Great service",
          reviewerName: "Pat Reviewer",
          createTime: "2026-10-20T10:00:00.000Z",
        },
      },
    });
    expect(p.payload.data.review.appUrl.endsWith(`/reviews?review=${r!.id}`)).toBe(true);
    expect(byId.get(anon!.id)!.payload.data.review.reviewerName).toBeNull();
    expect(byId.get(anon!.id)!.payload.data.review.starRating).toBeNull();
  });

  it("the JSON Schema is the v1 contract", async () => {
    const schema = JSON.stringify(z.toJSONSchema(reviewCreatedPayload), null, 2) + "\n";
    // A failure here means a breaking change: add a field, or plan /v2.
    await expect(schema).toMatchFileSnapshot("./__snapshots__/webhook-review-created.schema.json");
  });
});

type Sub = { subscription: { id: string; url: string }; secret: string };
let n = 0;
const hook = () => `https://3.3.3.3/hook/${++n}`; // a public IP literal: no DNS needed

describe("webhook actions", () => {
  it("subscribe as owner returns a one-time secret that is stored encrypted", async () => {
    const org = await kit.makeOrg();
    const out = await kit.run<Sub>(org.owner, "webhooks.subscribe", { url: hook() });
    expect(out.secret.startsWith("whsec_")).toBe(true);
    const [row] = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, out.subscription.id));
    expect(row!.secretEnc).not.toContain(out.secret);
    expect(decryptSecret(row!.secretEnc)).toBe(out.secret);
    expect(row!.status).toBe("active");
    expect(row!.events).toEqual(["review.created"]);
  });

  it("refuses a manager and a read-only token", async () => {
    const org = await kit.makeOrg();
    expect(await codeOf(kit.run(org.manager, "webhooks.subscribe", { url: hook() }))).toBe("FORBIDDEN");
    const readOnly: Actor = { ...org.owner, actorType: "api_token", surface: "mcp", scopes: ["read"] };
    expect(await codeOf(kit.run(readOnly, "webhooks.subscribe", { url: hook() }))).toBe("FORBIDDEN");
    expect(await codeOf(kit.run(org.manager, "webhooks.list"))).toBe("FORBIDDEN");
    expect(await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.orgId, org.orgId))).toHaveLength(0);
  });

  it("a blocked URL gives INVALID_INPUT and stores nothing", async () => {
    const org = await kit.makeOrg();
    for (const u of ["http://3.3.3.3/x", "https://127.0.0.1/x", "https://169.254.169.254/x", "https://3.3.3.3:8443/x"]) {
      expect(await codeOf(kit.run(org.owner, "webhooks.subscribe", { url: u })), u).toBe("INVALID_INPUT");
    }
    expect(await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.orgId, org.orgId))).toHaveLength(0);
  });

  it("the 11th active subscription gives CONFLICT; turning one off frees a slot", async () => {
    const org = await kit.makeOrg();
    const ids: string[] = [];
    for (let i = 0; i < WEBHOOK_MAX_ACTIVE_PER_ORG; i++) {
      ids.push((await kit.run<Sub>(org.owner, "webhooks.subscribe", { url: hook() })).subscription.id);
    }
    expect(await codeOf(kit.run(org.owner, "webhooks.subscribe", { url: hook() }))).toBe("CONFLICT");
    await db.update(webhookSubscriptions).set({ status: "disabled" }).where(eq(webhookSubscriptions.id, ids[0]!));
    await kit.run(org.owner, "webhooks.subscribe", { url: hook() });
    // Re-enabling the disabled one would be the 11th active again.
    expect(await codeOf(kit.run(org.owner, "webhooks.setStatus", { id: ids[0], status: "active" }))).toBe("CONFLICT");
  });

  it("a workspace outside the actor's scope or organization gives FORBIDDEN", async () => {
    const org = await kit.makeOrg();
    const other = await kit.makeOrg();
    expect(await codeOf(kit.run(org.owner, "webhooks.subscribe", { url: hook(), workspaceId: other.a }))).toBe("FORBIDDEN");
    const scoped: Actor = { ...org.owner, workspaceIds: [org.b] };
    expect(await codeOf(kit.run(scoped, "webhooks.subscribe", { url: hook(), workspaceId: org.a }))).toBe("FORBIDDEN");
    const ok = await kit.run<Sub>(org.owner, "webhooks.subscribe", { url: hook(), workspaceId: org.a });
    expect(ok.subscription).toMatchObject({ workspaceId: org.a });
  });

  it("list never contains the secret; unsubscribe of another org's id is NOT_FOUND", async () => {
    const org = await kit.makeOrg();
    const other = await kit.makeOrg();
    const a = await kit.run<Sub>(org.owner, "webhooks.subscribe", { url: hook() });
    const b = await kit.run<Sub>(other.owner, "webhooks.subscribe", { url: hook() });
    const listed = await kit.run<{ webhooks: { id: string }[] }>(org.owner, "webhooks.list");
    const text = JSON.stringify(listed);
    expect(text).not.toContain(a.secret);
    expect(text).not.toContain("whsec_");
    expect(text).not.toMatch(/secret/i);
    expect(listed.webhooks.map((w) => w.id)).toEqual([a.subscription.id]);
    expect(await codeOf(kit.run(org.owner, "webhooks.unsubscribe", { id: b.subscription.id }))).toBe("NOT_FOUND");
    expect(await codeOf(kit.run(org.owner, "webhooks.deliveries", { id: b.subscription.id }))).toBe("NOT_FOUND");
    expect(await codeOf(kit.run(org.owner, "webhooks.sendTest", { id: b.subscription.id }))).toBe("NOT_FOUND");
    await kit.run(org.owner, "webhooks.unsubscribe", { id: a.subscription.id });
    expect((await kit.run<{ webhooks: unknown[] }>(org.owner, "webhooks.list")).webhooks).toHaveLength(0);
  });

  it("every write writes exactly one audit row with no secret and no URL path", async () => {
    const org = await kit.makeOrg();
    const url = hook();
    const sub = await kit.run<Sub>(org.owner, "webhooks.subscribe", { url });
    await kit.run(org.owner, "webhooks.sendTest", { id: sub.subscription.id });
    await kit.run(org.owner, "webhooks.setStatus", { id: sub.subscription.id, status: "disabled" });
    await kit.run(org.owner, "webhooks.unsubscribe", { id: sub.subscription.id });
    for (const action of ["webhook.subscribe", "webhook.test_queued", "webhook.set_status", "webhook.unsubscribe"]) {
      const rows = await kit.auditRows(org.orgId, action);
      expect(rows, action).toHaveLength(1);
      const text = JSON.stringify(rows[0]);
      expect(text).not.toContain(sub.secret);
      expect(text).not.toContain("whsec_");
      expect(text).not.toContain(new URL(url).pathname);
    }
  });

  it("deliveries lists the last 50 without payloads; sendTest queues one test delivery and a job", async () => {
    const org = await kit.makeOrg();
    const sub = await kit.run<Sub>(org.owner, "webhooks.subscribe", { url: hook() });
    await db.insert(webhookDeliveries).values(
      Array.from({ length: 55 }, (_, i) => ({
        orgId: org.orgId,
        workspaceId: org.a,
        subscriptionId: sub.subscription.id,
        eventType: "review.created",
        entityId: `e${i}`,
        payload: { comment: "PRIVATE REVIEW TEXT" },
        status: "delivered" as const,
        attempts: 1,
        lastStatusCode: 200,
        createdAt: new Date(Date.now() - i * 1000),
      })),
    );
    const out = await kit.run<{ deliveries: Record<string, unknown>[] }>(org.owner, "webhooks.deliveries", { id: sub.subscription.id });
    expect(out.deliveries).toHaveLength(50);
    expect(JSON.stringify(out)).not.toContain("PRIVATE REVIEW TEXT");
    expect(Object.keys(out.deliveries[0]!)).not.toContain("payload");

    const test = await kit.run<{ deliveryId: string }>(org.owner, "webhooks.sendTest", { id: sub.subscription.id });
    const [d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, test.deliveryId));
    expect(d).toMatchObject({ test: true, status: "pending", subscriptionId: sub.subscription.id });
    expect((d!.payload as { test: boolean }).test).toBe(true);
    const jobs = await client`select id from pgboss.job where name = ${WEBHOOK_QUEUE} and data->>'deliveryId' = ${test.deliveryId}`;
    expect(jobs).toHaveLength(1);
    const listed = await kit.run<{ webhooks: { lastDelivery: { test: boolean } | null }[] }>(org.owner, "webhooks.list");
    expect(listed.webhooks[0]!.lastDelivery).toMatchObject({ test: true, status: "pending" });
  });
});

describe("purgeOldWebhookDeliveries", () => {
  it("deletes settled deliveries older than the retention window, keeps pending and newer ones", async () => {
    const org = await kit.makeOrg();
    const sub = await kit.run<Sub>(org.owner, "webhooks.subscribe", { url: hook() });
    const now = new Date("2026-10-23T00:00:00Z");
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const row = (entityId: string, status: "pending" | "delivered" | "failed" | "skipped", createdAt: Date) => ({
      orgId: org.orgId,
      workspaceId: org.a,
      subscriptionId: sub.subscription.id,
      eventType: "review.created",
      entityId,
      payload: {},
      status,
      createdAt,
    });
    await db.insert(webhookDeliveries).values([
      row("old-delivered", "delivered", ago(WEBHOOK_DELIVERY_RETENTION_DAYS + 1)),
      row("old-failed", "failed", ago(WEBHOOK_DELIVERY_RETENTION_DAYS + 5)),
      row("old-skipped", "skipped", ago(WEBHOOK_DELIVERY_RETENTION_DAYS + 5)),
      row("old-pending", "pending", ago(WEBHOOK_DELIVERY_RETENTION_DAYS + 5)),
      row("new-delivered", "delivered", ago(WEBHOOK_DELIVERY_RETENTION_DAYS - 1)),
    ]);
    // The purge is global, so other suites' old rows (none expected) would be counted too: assert on ours.
    const deleted = await purgeOldWebhookDeliveries(db, now);
    expect(deleted).toBeGreaterThanOrEqual(3);
    const left = await db.select({ e: webhookDeliveries.entityId }).from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, sub.subscription.id));
    expect(left.map((l) => l.e).sort()).toEqual(["new-delivered", "old-pending"]);
    console.log(`purge deleted ${deleted} deliveries older than ${WEBHOOK_DELIVERY_RETENTION_DAYS} days`);
  });
});
