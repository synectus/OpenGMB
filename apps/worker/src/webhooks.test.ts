import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { WEBHOOK_PURGE_CRON, WEBHOOK_PURGE_QUEUE, WEBHOOK_QUEUE, WEBHOOK_QUEUE_OPTIONS, encryptSecret, generateWebhookSecret } from "@opengmb/core";
import {
  createDb,
  memberships,
  organizations,
  users,
  webhookDeliveries,
  webhookSubscriptions,
  workspaces,
} from "@opengmb/db";
import { handleWebhookJobs, registerWebhookJobs } from "./webhooks";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  await boss.start();
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await sql.end();
});

describe("webhook worker", () => {
  it("registers the delivery queue with the retry options, idempotently", async () => {
    // Private queue names: the live consumer here can never take a job another test file enqueues on
    // the real `webhook.deliver` queue (which would make a real HTTPS call).
    const queues = { deliver: `${WEBHOOK_QUEUE}.test-${uniq()}`, purge: `${WEBHOOK_PURGE_QUEUE}.test-${uniq()}` };
    expect(queues.deliver).not.toBe(WEBHOOK_QUEUE);
    await registerWebhookJobs(boss, db, queues);
    await registerWebhookJobs(boss, db, queues);
    await boss.offWork(queues.deliver, { wait: false });
    await boss.offWork(queues.purge, { wait: false });
    const schedules = await boss.getSchedules(queues.purge);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ name: queues.purge, cron: WEBHOOK_PURGE_CRON, timezone: "UTC" });
    const q = await boss.getQueue(queues.deliver);
    expect(q).toMatchObject({
      name: queues.deliver,
      retryLimit: WEBHOOK_QUEUE_OPTIONS.retryLimit,
      retryDelay: WEBHOOK_QUEUE_OPTIONS.retryDelay,
      retryBackoff: true,
    });
    expect(WEBHOOK_QUEUE_OPTIONS.retryLimit).toBe(8);
    await boss.deleteQueue(queues.deliver);
    await boss.deleteQueue(queues.purge);
  });

  it("a job runs the real delivery handler (a loopback target is refused, nothing is sent)", async () => {
    const [org] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
    const [ws] = await db.insert(workspaces).values({ orgId: org!.id, name: "A" }).returning();
    const userId = `u-${uniq()}`;
    await db.insert(users).values({ id: userId, name: "T", email: `${userId}@example.test` });
    await db.insert(memberships).values({ orgId: org!.id, userId, role: "owner" });
    const [s] = await db
      .insert(webhookSubscriptions)
      .values({
        orgId: org!.id,
        url: "https://127.0.0.1/hook",
        events: ["review.created"],
        secretEnc: encryptSecret(generateWebhookSecret()),
        createdByUserId: userId,
      })
      .returning();
    const [d] = await db
      .insert(webhookDeliveries)
      .values({ orgId: org!.id, workspaceId: ws!.id, subscriptionId: s!.id, eventType: "review.created", entityId: "e1", payload: {} })
      .returning();
    const blockedBefore = (globalThis as { __blockedPublicConnects?: string[] }).__blockedPublicConnects?.length ?? 0;
    await handleWebhookJobs(db, [{ id: "job-1", data: { deliveryId: d!.id }, retryCount: 0, retryLimit: 8 }]);
    const [after] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, d!.id));
    expect(after).toMatchObject({ status: "failed", lastError: "blocked_address" });
    // Canary: the process-wide network guard (vitest.setup.ts) is installed and nothing public was attempted.
    expect((net.Socket.prototype.connect as unknown as Record<symbol, boolean>)[Symbol.for("syngmb.blockPublicNetwork")]).toBe(true);
    expect((globalThis as { __blockedPublicConnects?: string[] }).__blockedPublicConnects?.length ?? 0).toBe(blockedBefore);
  });
});
