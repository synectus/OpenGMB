import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  createDb,
  memberships,
  reviewAutoDrafts,
  reviewReplies,
  reviews,
  workspaceReplySettings,
} from "@opengmb/db";
import { setAiTestOverrides, type AiModel } from "./ai/model";
import { DRAFT_ON_ARRIVAL } from "./config/draft-on-arrival";
import { MockGoogleClient } from "./google/mock-client";
import { DRAFT_ARRIVAL_QUEUE, processArrivalDraft } from "./reviews/draft-on-arrival";
import { processReviewSync, REVIEW_SYNC_QUEUE } from "./reviews/sync";
import { REPLY_PUBLISH_QUEUE } from "./reviews/reply-jobs";
import { makeKit, type Org, type Loc } from "./testkit";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: pg } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const { run } = kit;
const boss = new PgBoss(url);

beforeAll(async () => {
  await boss.start();
  for (const q of [REVIEW_SYNC_QUEUE, DRAFT_ARRIVAL_QUEUE, REPLY_PUBLISH_QUEUE]) await boss.createQueue(q);
});
afterAll(async () => {
  await boss.stop();
  setAiTestOverrides({});
  vi.unstubAllGlobals();
  await kit.deactivateAll();
  await pg.end();
});

let modelCalls = 0;
const fake: AiModel = async () => {
  modelCalls++;
  return { text: "Thank you for the kind words. We hope to see you again soon.", inputTokens: 100, outputTokens: 50 };
};
const useModel = () => setAiTestOverrides({ model: fake, env: { AI_MONTHLY_BUDGET_USD: "1000" } });

beforeEach(() => {
  modelCalls = 0;
  useModel();
  vi.stubGlobal("fetch", () => {
    throw new Error("the real network must never be reached in tests");
  });
});

type Case = { o: Org; l: Loc };
/** An org with one location whose first (import) sync is done, so the next sync is "news". */
async function mkCase(opts: { on?: boolean; rules?: Record<string, unknown> } = {}): Promise<Case> {
  const o = await kit.makeOrg();
  const l = await o.mkLoc(o.a);
  await syncLoc({ o, l });
  if (opts.on !== false) {
    await run(o.owner, "workspaceSettings.update", { workspaceId: o.a, draftOnArrival: true, ...opts.rules });
  }
  return { o, l };
}
const add = (c: Case, init: Parameters<MockGoogleClient["addReview"]>[2] = {}) =>
  mock.addReview(c.l.row.googleAccountName!, c.l.row.googleLocationId!, init);
async function syncLoc(c: Case) {
  const out = (await run(c.o.manager, "reviews.sync", { workspaceId: c.o.a, locationIds: [c.l.row.id] })) as {
    syncs: { syncId: string }[];
  };
  return processReviewSync(db, out.syncs[0]!.syncId, { client: mock });
}
const reviewIds = async (c: Case) =>
  (await db.select({ id: reviews.id }).from(reviews).where(eq(reviews.locationId, c.l.row.id))).map((r) => r.id);
/** Draft jobs queued for this location's reviews. */
async function jobsFor(c: Case): Promise<string[]> {
  const ids = await reviewIds(c);
  if (ids.length === 0) return [];
  const rows = await pg`select data->>'reviewId' as id from pgboss.job where name = ${DRAFT_ARRIVAL_QUEUE} and data->>'reviewId' = any(${ids})`;
  return rows.map((r) => r.id as string);
}
const repliesFor = async (c: Case) =>
  db
    .select()
    .from(reviewReplies)
    .where(inArray(reviewReplies.reviewId, await reviewIds(c)));
/** What the worker does: one processArrivalDraft per queued job. */
async function runJobs(c: Case) {
  const out: string[] = [];
  for (const id of await jobsFor(c)) out.push(await processArrivalDraft(db, id));
  return out;
}

describe("draft on arrival", () => {
  it("a new review queues one job and gets one draft waiting in approval; a re-sync and a re-run add nothing", async () => {
    const c = await mkCase();
    add(c, { starRating: "TWO", comment: "Waited a long time." });
    const counts = await syncLoc(c);
    expect(counts?.inserted).toBe(1);
    expect(modelCalls).toBe(0); // the sync never calls the model
    expect(await jobsFor(c)).toHaveLength(1);

    expect(await runJobs(c)).toEqual(["drafted"]);
    expect(modelCalls).toBe(1);
    const [reply] = await repliesFor(c);
    expect(reply!.status).toBe("pending_approval");
    expect(reply!.createdBy).toBe(c.o.ownerId);

    // The same sync again finds nothing new; the same job again finds its claim.
    await syncLoc(c);
    expect(await jobsFor(c)).toHaveLength(1);
    expect(await runJobs(c)).toEqual(["duplicate"]);
    expect(modelCalls).toBe(1);
    expect(await repliesFor(c)).toHaveLength(1);
    const [claim] = await db.select().from(reviewAutoDrafts).where(eq(reviewAutoDrafts.workspaceId, c.o.a));
    expect(claim!.outcome).toBe("drafted");
    expect(claim!.replyId).toBe(reply!.id);
    const audit = await kit.auditRows(c.o.orgId, "review_draft.arrival");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("Waited a long time");
  });

  it("does nothing when the setting is off (the default)", async () => {
    const c = await mkCase({ on: false });
    expect((await db.select().from(workspaceReplySettings).where(eq(workspaceReplySettings.workspaceId, c.o.a)))[0]?.draftOnArrival ?? false).toBe(false);
    add(c);
    await syncLoc(c);
    expect(await jobsFor(c)).toHaveLength(0);
    expect(modelCalls).toBe(0);
    // A job that was queued before the setting was switched off also does nothing.
    const [id] = await reviewIds(c);
    expect(await processArrivalDraft(db, id!)).toBe("off");
    expect(await repliesFor(c)).toHaveLength(0);
  });

  it("queues nothing on a location's first sync (an import), for replied reviews, or for old reviews", async () => {
    const o = await kit.makeOrg();
    const l = await o.mkLoc(o.a);
    const c = { o, l };
    await run(o.owner, "workspaceSettings.update", { workspaceId: o.a, draftOnArrival: true });
    add(c, { comment: "history" });
    await syncLoc(c); // first sync
    expect(await jobsFor(c)).toHaveLength(0);

    add(c, { reply: "Already answered on Google" });
    add(c, { createTime: new Date(Date.now() - (DRAFT_ON_ARRIVAL.maxAgeDays + 1) * 86_400_000).toISOString() });
    add(c, { comment: "fresh" });
    await syncLoc(c);
    expect(await jobsFor(c)).toHaveLength(1);
  });

  it("skips 4-5 star reviews when the client does not reply to positive reviews", async () => {
    const c = await mkCase({ rules: { skipPositiveReviews: true } });
    add(c, { starRating: "FIVE" });
    add(c, { starRating: "ONE" });
    await syncLoc(c);
    expect(await jobsFor(c)).toHaveLength(1);
    expect(await runJobs(c)).toEqual(["drafted"]);
  });

  it("queues at most the per-sync cap, newest first", async () => {
    const c = await mkCase();
    const extra = 3;
    for (let i = 0; i < DRAFT_ON_ARRIVAL.maxPerSync + extra; i++) {
      add(c, { starRating: "THREE", createTime: new Date(Date.now() - i * 60_000).toISOString() });
    }
    const counts = await syncLoc(c);
    expect(counts?.inserted).toBe(DRAFT_ON_ARRIVAL.maxPerSync + extra);
    expect(await jobsFor(c)).toHaveLength(DRAFT_ON_ARRIVAL.maxPerSync);
    const queued = new Set(await jobsFor(c));
    const oldest = await db
      .select({ id: reviews.id })
      .from(reviews)
      .where(eq(reviews.locationId, c.l.row.id))
      .orderBy(reviews.createTime)
      .limit(extra);
    expect(oldest.some((r) => queued.has(r.id))).toBe(false);
    const audit = await kit.auditRows(c.o.orgId, "review_draft.arrival_queued");
    expect(audit).toHaveLength(1);
  });

  it("applies the client's star rule exactly as for a manual draft: 5 stars approved, 1 star waits for a person", async () => {
    const c = await mkCase({ rules: { autoApproveMinStars: 4 } });
    add(c, { starRating: "FIVE", comment: "Lovely" });
    add(c, { starRating: "ONE", comment: "Awful" });
    await syncLoc(c);
    expect((await runJobs(c)).sort()).toEqual(["drafted", "drafted"]);
    const byRating = new Map<number, string>();
    for (const r of await repliesFor(c)) {
      const [rv] = await db.select().from(reviews).where(eq(reviews.id, r.reviewId));
      byRating.set(rv!.starRating!, r.status);
    }
    expect(byRating.get(5)).toBe("approved"); // not published: auto-publish is off
    expect(byRating.get(1)).toBe("pending_approval");
  });

  it("stops when the person who switched it on can no longer draft for the client", async () => {
    const c = await mkCase();
    add(c);
    await syncLoc(c);
    await db.delete(memberships).where(and(eq(memberships.orgId, c.o.orgId), eq(memberships.userId, c.o.ownerId)));
    expect(await runJobs(c)).toEqual(["skipped_no_actor"]);
    expect(modelCalls).toBe(0);
  });
});

describe("workspaceSettings.draftOnArrival", () => {
  it("defaults off, is owner/admin only, and records who switched it on", async () => {
    const o = await kit.makeOrg();
    const get = () => run<{ draftOnArrival: boolean }>(o.owner, "workspaceSettings.get", { workspaceId: o.a });
    expect((await get()).draftOnArrival).toBe(false);
    await expect(run(o.manager, "workspaceSettings.update", { workspaceId: o.a, draftOnArrival: true })).rejects.toThrow();
    await run(o.owner, "workspaceSettings.update", { workspaceId: o.a, draftOnArrival: true });
    expect((await get()).draftOnArrival).toBe(true);
    const [row] = await db.select().from(workspaceReplySettings).where(eq(workspaceReplySettings.workspaceId, o.a));
    expect(row!.draftOnArrivalBy).toBe(o.ownerId);
    await run(o.owner, "workspaceSettings.update", { workspaceId: o.a, draftOnArrival: false });
    const [off] = await db.select().from(workspaceReplySettings).where(eq(workspaceReplySettings.workspaceId, o.a));
    expect(off!.draftOnArrivalBy).toBeNull();
  });
});
