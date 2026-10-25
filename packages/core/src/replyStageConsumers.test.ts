import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, reviewReplies, reviews } from "@opengmb/db";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { makeKit, uniq, type Loc, type Org } from "./testkit";

// F5: Home, the location Overview and Health read one definition of "needs a reply".
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const { run } = kit;

type Counts = {
  reviews: { total: number };
  failed: { reply: number };
  waitingToPublish: number;
  total: number;
};
type Stats = { reviews: { unreplied: number; waitingToPublish: number } };
type Check = { id: string; status: string; detail: string };

let org: Org;
let seq = 0;
beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  setSharedMockGoogleClient(mock);
  org = await kit.makeOrg();
});
afterAll(async () => {
  setSharedMockGoogleClient(null);
  await kit.deactivateAll();
  await sql.end();
});

async function seed(
  loc: Loc,
  o: { open?: "pending_approval" | "approved" | "failed"; replied?: boolean; daysAgo?: number },
) {
  const at = new Date(Date.now() - (o.daysAgo ?? 1) * 86_400_000 - seq * 1000);
  const [r] = await db
    .insert(reviews)
    .values({
      orgId: loc.row.orgId,
      workspaceId: loc.row.workspaceId,
      locationId: loc.row.id,
      googleReviewName: `${loc.parent}/reviews/${uniq()}-${seq++}`,
      starRating: 2,
      comment: "Waited too long.",
      createTime: at,
      updateTime: at,
      replyComment: o.replied ? "Thanks" : null,
      replyState: o.replied ? "APPROVED" : null,
    })
    .returning();
  if (o.open)
    await db.insert(reviewReplies).values({
      orgId: r!.orgId,
      workspaceId: r!.workspaceId,
      reviewId: r!.id,
      revision: 1,
      body: "Thank you for telling us.",
      status: o.open,
      createdBy: org.ownerId,
      createdSurface: "ui",
      submittedAt: new Date(),
      approvedAt: o.open === "approved" ? new Date() : null,
      approvedBy: o.open === "approved" ? org.ownerId : null,
      failureReason: o.open === "failed" ? "google_writes_disabled" : null,
    });
  return r!;
}

async function views(loc: Loc) {
  const id = loc.row.id;
  const [home, overview, stats, health, list] = await Promise.all([
    run<Counts>(org.owner, "attention.counts", { workspaceId: loc.row.workspaceId }),
    run<{ stats: Stats }>(org.owner, "locations.overview", { locationId: id }),
    run<{ locations: Stats[] }>(org.owner, "locations.stats", { locationIds: [id] }),
    run<{ checks: Check[] }>(org.owner, "locations.healthcheck", { locationId: id }),
    run<{ items: unknown[] }>(org.owner, "reviews.list", { locationIds: [id], replied: false, limit: 100 }),
  ]);
  return {
    home,
    overview: overview.stats.reviews,
    stats: stats.locations[0]!.reviews,
    health: health.checks.find((c) => c.id === "unreplied_reviews")!,
    list: list.items.length,
  };
}

describe("one needs-you count across Home, Overview and Health", () => {
  it("the audit case: one approved-but-unpublished reply needs nobody, and every page says so", async () => {
    const loc = await org.mkLoc(org.a);
    await seed(loc, { open: "approved" });
    const v = await views(loc);
    expect(v.home.reviews.total).toBe(0);
    expect(v.home.failed.reply).toBe(0);
    expect(v.home.total).toBe(0);
    expect(v.home.waitingToPublish).toBe(1);
    expect(v.overview).toMatchObject({ unreplied: 0, waitingToPublish: 1 });
    expect(v.stats).toEqual(v.overview);
    expect(v.health.status).toBe("pass");
    expect(v.health.detail).toContain("1 approved reply waiting to publish");
    expect(v.list).toBe(0);
  });

  it("a mixed location: Home's two buckets add up to Overview's number, Health and the list match", async () => {
    const loc = await org.mkLoc(org.b);
    await seed(loc, { open: "approved" }); // waiting to publish
    await seed(loc, {}); // needs a reply
    await seed(loc, { open: "pending_approval" }); // an approver's job
    await seed(loc, { open: "failed" }); // needs you: retry
    await seed(loc, { replied: true }); // done
    const v = await views(loc);
    expect(v.home.reviews.total).toBe(1);
    expect(v.home.failed.reply).toBe(1);
    expect(v.home.waitingToPublish).toBe(1);
    expect(v.overview.unreplied).toBe(2);
    expect(v.home.reviews.total + v.home.failed.reply).toBe(v.overview.unreplied);
    expect(v.stats).toEqual(v.overview);
    expect(v.health.status).toBe("fail");
    expect(v.health.detail).toContain("2 reviews");
    expect(v.health.detail).toContain("1 approved reply waiting to publish");
    expect(v.list).toBe(v.overview.unreplied);
  });

  it("Health keeps its 30-day window; the same review outside it is not counted", async () => {
    const loc = await org.mkLoc(org.a);
    await seed(loc, { daysAgo: 60 }); // old, needs a reply
    const v = await views(loc);
    expect(v.overview.unreplied).toBe(1);
    expect(v.health.status).toBe("pass");
  });
});
