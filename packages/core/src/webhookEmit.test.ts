import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createDb, reviews, webhookDeliveries, webhookSubscriptions } from "@opengmb/db";
import { WEBHOOK_QUEUE } from "./config/webhooks";
import { MockGoogleClient } from "./google/mock-client";
import { REVIEW_SYNC_QUEUE, processReviewSync } from "./reviews/sync";
import type { ReviewChange } from "./reviews/upsert";
import { makeKit, type Loc, type Org } from "./testkit";
import { emitReviewCreated } from "./webhooks/emit";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const boss = new PgBoss(url);
beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  await boss.start();
  await boss.createQueue(WEBHOOK_QUEUE);
  await boss.createQueue(REVIEW_SYNC_QUEUE);
  await boss.stop();
});
afterAll(async () => {
  await kit.deactivateAll();
  await client.end();
});

const NOW = new Date("2026-10-23T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
let seq = 0;

async function fixture() {
  const org = await kit.makeOrg();
  const loc = await org.mkLoc(org.a);
  return { org, loc };
}

async function sub(org: Org, extra: Partial<typeof webhookSubscriptions.$inferInsert> = {}) {
  const [s] = await db
    .insert(webhookSubscriptions)
    .values({
      orgId: org.orgId,
      url: "https://3.3.3.3/hook",
      events: ["review.created"],
      secretEnc: "unused",
      createdByUserId: org.ownerId,
      ...extra,
    })
    .returning();
  return s!;
}

/** Inserts a stored review and returns the change the upsert would have reported. */
async function change(org: Org, loc: Loc, createTime: Date, wasInserted = true): Promise<ReviewChange> {
  const [r] = await db
    .insert(reviews)
    .values({
      orgId: org.orgId,
      workspaceId: loc.row.workspaceId,
      locationId: loc.row.id,
      googleReviewName: `${loc.parent}/reviews/e${++seq}-${Math.random()}`,
      starRating: 5,
      createTime,
      updateTime: createTime,
    })
    .returning();
  return { reviewId: r!.id, wasInserted, rating: 5, previousRating: null, createTime, updateTime: createTime };
}

const emit = (org: Org, loc: Loc, changes: ReviewChange[], firstSync = false) =>
  db.transaction((tx) =>
    emitReviewCreated(tx, { id: loc.row.id, orgId: org.orgId, workspaceId: loc.row.workspaceId }, changes, {
      now: NOW,
      firstSync,
    }),
  );

const deliveriesOf = (org: Org) =>
  db.select().from(webhookDeliveries).where(eq(webhookDeliveries.orgId, org.orgId));
const jobsFor = async (ids: string[]) =>
  ids.length === 0
    ? []
    : await client`select id from pgboss.job where name = ${WEBHOOK_QUEUE} and data->>'deliveryId' = any(${ids})`;

describe("emitReviewCreated", () => {
  it("one new review, one active org-wide subscription: 1 delivery and 1 job", async () => {
    const { org, loc } = await fixture();
    await sub(org);
    const changes = [await change(org, loc, daysAgo(1))];
    const out = await emit(org, loc, changes);
    const rows = await deliveriesOf(org);
    console.log(`${changes.length} changes, ${rows.length} deliveries`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", test: false, entityId: changes[0]!.reviewId });
    expect(await jobsFor(out.deliveryIds)).toHaveLength(1);
    expect((await kit.auditRows(org.orgId, "webhook.queued"))).toHaveLength(1);
  });

  it("updates only (wasInserted false) give 0", async () => {
    const { org, loc } = await fixture();
    await sub(org);
    await emit(org, loc, [await change(org, loc, daysAgo(1), false)]);
    expect(await deliveriesOf(org)).toHaveLength(0);
    expect(await kit.auditRows(org.orgId, "webhook.queued")).toHaveLength(0);
  });

  it("the backfill cutoff: 15 days ago gives 0, 13 days ago gives 1", async () => {
    const { org, loc } = await fixture();
    await sub(org);
    await emit(org, loc, [await change(org, loc, daysAgo(15))]);
    expect(await deliveriesOf(org)).toHaveLength(0);
    await emit(org, loc, [await change(org, loc, daysAgo(13))]);
    expect(await deliveriesOf(org)).toHaveLength(1);
  });

  it("firstSync gives 0 even for a fresh review", async () => {
    const { org, loc } = await fixture();
    await sub(org);
    await emit(org, loc, [await change(org, loc, daysAgo(1))], true);
    expect(await deliveriesOf(org)).toHaveLength(0);
  });

  it("a disabled subscription gives 0", async () => {
    const { org, loc } = await fixture();
    await sub(org, { status: "disabled", disabledReason: "manual" });
    await emit(org, loc, [await change(org, loc, daysAgo(1))]);
    expect(await deliveriesOf(org)).toHaveLength(0);
  });

  it("a subscription for another workspace gives 0; for the same workspace gives 1", async () => {
    const { org, loc } = await fixture();
    await sub(org, { workspaceId: org.b });
    const changes = [await change(org, loc, daysAgo(1))];
    await emit(org, loc, changes);
    expect(await deliveriesOf(org)).toHaveLength(0);
    await sub(org, { workspaceId: org.a });
    await emit(org, loc, changes);
    expect(await deliveriesOf(org)).toHaveLength(1);
  });

  it("another organization's subscription never receives the event", async () => {
    const { org, loc } = await fixture();
    const other = await kit.makeOrg();
    await sub(other);
    await emit(org, loc, [await change(org, loc, daysAgo(1))]);
    expect(await deliveriesOf(other)).toHaveLength(0);
  });

  it("running the same changes twice still gives 1 (unique key), with one job", async () => {
    const { org, loc } = await fixture();
    await sub(org);
    const changes = [await change(org, loc, daysAgo(1))];
    const first = await emit(org, loc, changes);
    const second = await emit(org, loc, changes);
    expect(await deliveriesOf(org)).toHaveLength(1);
    expect(second.deliveryIds).toHaveLength(0);
    expect(await jobsFor(first.deliveryIds)).toHaveLength(1);
  });

  it("rollback: emit inside a transaction that then throws leaves 0 deliveries and 0 jobs", async () => {
    const { org, loc } = await fixture();
    await sub(org);
    const changes = [await change(org, loc, daysAgo(1))];
    let ids: string[] = [];
    await expect(
      db.transaction(async (tx) => {
        ids = (
          await emitReviewCreated(tx, { id: loc.row.id, orgId: org.orgId, workspaceId: loc.row.workspaceId }, changes, { now: NOW })
        ).deliveryIds;
        expect(ids).toHaveLength(1);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await deliveriesOf(org)).toHaveLength(0);
    expect(await jobsFor(ids)).toHaveLength(0);
  });
});

describe("review sync wiring", () => {
  it("the first sync of a location delivers nothing; a later sync with one new review delivers once", async () => {
    const { org, loc } = await fixture();
    await sub(org);
    const syncOnce = async () => {
      const out = await kit.run<{ syncs: { syncId: string }[] }>(org.owner, "reviews.sync", {
        workspaceId: org.a,
        locationIds: [loc.row.id],
      });
      return processReviewSync(db, out.syncs[0]!.syncId, { client: mock });
    };
    const first = await syncOnce();
    expect(first).not.toBeNull();
    expect(await deliveriesOf(org)).toHaveLength(0);

    const reviewName = mock.addReview(loc.row.googleAccountName!, loc.row.googleLocationId!, {
      starRating: "FOUR",
      comment: "Fresh review",
    });
    const second = await syncOnce();
    console.log(`2 syncs, ${second?.inserted} inserted, ${(await deliveriesOf(org)).length} deliveries`);
    expect(second?.inserted).toBe(1);
    const rows = await deliveriesOf(org);
    expect(rows).toHaveLength(1);
    const [rev] = await db
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.googleReviewName, reviewName), inArray(reviews.locationId, [loc.row.id])));
    expect(rows[0]!.entityId).toBe(rev!.id);

    // Nothing changed upstream: a third sync delivers nothing more.
    await syncOnce();
    expect(await deliveriesOf(org)).toHaveLength(1);
  });
});
