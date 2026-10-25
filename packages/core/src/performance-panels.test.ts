import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { locations, postTargets, posts, reviews } from "@opengmb/db";
import type { Actor } from "./actor";
import { executeAction } from "./executor";
import { ROLE_PERMISSIONS } from "./permissions";
import { codeOf, db, makeOrg, putDaily, sql, uniq, type Org } from "./performance-fixture";

const run = (actor: Actor, name: string, input: unknown = {}) =>
  executeAction(db, actor, name, input);

type D = { total: number; previousTotal: number; delta: number; deltaPct: number | null };
type Row = {
  locationId: string;
  title: string;
  status: "active" | "inactive";
  needsRelink: boolean;
  lastDataDate: string | null;
  calls: D;
  websiteClicks: D;
  directions: D;
  actions: D;
};
type Activity = {
  newReviews: number;
  averageRating: number | null;
  unreplied: number;
  postsPublished: number;
};

const range = { from: "2026-09-08", to: "2026-09-14" }; // previous: 2026-09-01..2026-09-07
let o: Org;
let other: Org;

async function addReview(loc: { id: string; workspaceId: string }, at: string, stars: number | null, replied: boolean) {
  await db.insert(reviews).values({
    orgId: o.orgId,
    workspaceId: loc.workspaceId,
    locationId: loc.id,
    googleReviewName: `accounts/1/locations/1/reviews/${uniq()}`,
    starRating: stars,
    comment: "x",
    createTime: new Date(at),
    updateTime: new Date(at),
    replyComment: replied ? "thanks" : null,
  });
}

async function addPost(locIds: string[], publishedAt: string | null) {
  const [p] = await db
    .insert(posts)
    .values({
      orgId: o.orgId,
      workspaceId: o.wsA,
      createdBy: o.owner.userId,
      createdSurface: "ui",
      topicType: "STANDARD",
      summary: "s",
      status: "published",
    })
    .returning({ id: posts.id });
  await db.insert(postTargets).values(
    locIds.map((locationId) => ({
      postId: p!.id,
      orgId: o.orgId,
      locationId,
      status: "published" as const,
      publishedAt: publishedAt ? new Date(publishedAt) : null,
    })),
  );
}

beforeAll(async () => {
  o = await makeOrg();
  other = await makeOrg();
  await putDaily(o.orgId, o.locA1.id, [
    ["2026-09-08", "CALL_CLICKS", 10],
    ["2026-09-09", "WEBSITE_CLICKS", 6],
    ["2026-09-10", "BUSINESS_DIRECTION_REQUESTS", 4],
    ["2026-09-02", "CALL_CLICKS", 5], // previous period
    ["2026-09-09", "BUSINESS_IMPRESSIONS_MOBILE_MAPS", 999], // not an action metric
  ]);
  await putDaily(o.orgId, o.locA2.id, [
    ["2026-09-03", "CALL_CLICKS", 8], // previous only: actions fall from 8 to 0
    ["2026-10-13", "CALL_CLICKS", 1], // after the range: only moves lastDataDate
  ]);
  await putDaily(o.orgId, o.locB.id, [["2026-09-08", "CALL_CLICKS", 1000]]);
  // locA2 lost its Google connection (what googleConnections.disconnect leaves behind).
  await db.update(locations).set({ connectionId: null }).where(eq(locations.id, o.locA2.id));

  await addReview(o.locA1, "2026-09-08T00:00:00Z", 5, true); // first second of the range
  await addReview(o.locA1, "2026-09-14T23:59:59Z", 4, false); // last second of the range
  await addReview(o.locA2, "2026-09-10T12:00:00Z", null, false); // no rating: counts, not averaged
  await addReview(o.locA1, "2026-09-15T00:00:00Z", 1, false); // after the range
  await addReview(o.locA1, "2026-09-07T23:59:59Z", 1, false); // before the range
  await addPost([o.locA1.id, o.locA2.id], "2026-09-09T10:00:00Z"); // two targets, one post
  await addPost([o.locA1.id], "2026-09-20T10:00:00Z"); // outside
  await addPost([o.locA1.id], null); // never published
});
afterAll(async () => {
  await sql.end();
});

describe("performance.byLocation", () => {
  it("sums calls, clicks and directions per location, with a combined actions delta", async () => {
    const out = (await run(o.owner, "performance.byLocation", { workspaceId: o.wsA, ...range })) as {
      rows: Row[];
    };
    const byId = new Map(out.rows.map((r) => [r.locationId, r]));
    expect(out.rows.map((r) => r.title)).toEqual(["Acme Closed", "Acme Dental", "Acme Dental North"]);

    const a1 = byId.get(o.locA1.id)!;
    expect(a1.calls).toEqual({ total: 10, previousTotal: 5, delta: 5, deltaPct: 1 });
    expect(a1.websiteClicks.total).toBe(6);
    expect(a1.directions.total).toBe(4);
    expect(a1.actions).toEqual({ total: 20, previousTotal: 5, delta: 15, deltaPct: 3 });
    expect(a1).toMatchObject({ status: "active", needsRelink: false, lastDataDate: "2026-09-10" });

    const a2 = byId.get(o.locA2.id)!;
    expect(a2.actions).toEqual({ total: 0, previousTotal: 8, delta: -8, deltaPct: -1 });
    expect(a2).toMatchObject({ needsRelink: true, lastDataDate: "2026-10-13" });

    const off = byId.get(o.locAOff.id)!;
    expect(off).toMatchObject({ status: "inactive", lastDataDate: null });
    expect(off.actions).toEqual({ total: 0, previousTotal: 0, delta: 0, deltaPct: null });
  });

  it("accepts locationIds and refuses other workspaces, other orgs and bad input", async () => {
    const one = (await run(o.owner, "performance.byLocation", {
      locationIds: [o.locA1.id],
      ...range,
    })) as { rows: Row[] };
    expect(one.rows.map((r) => r.locationId)).toEqual([o.locA1.id]);
    expect(
      await codeOf(run(o.viewerA, "performance.byLocation", { locationIds: [o.locB.id], ...range })),
    ).toMatch(/^NOT_FOUND/);
    expect(
      await codeOf(run(other.owner, "performance.byLocation", { workspaceId: o.wsA, ...range })),
    ).toMatch(/^NOT_FOUND/);
    expect(await codeOf(run(o.owner, "performance.byLocation", { ...range }))).toMatch(
      /^INVALID_INPUT/,
    );
    expect(
      await codeOf(
        run(o.owner, "performance.byLocation", { workspaceId: o.wsA, from: "2026-09-14", to: "2026-09-08" }),
      ),
    ).toMatch(/^INVALID_INPUT/);
  });
});

describe("performance.activity", () => {
  it("counts reviews created in the range, averages rated ones, counts unreplied and distinct published posts", async () => {
    const a = (await run(o.viewerA, "performance.activity", { workspaceId: o.wsA, ...range })) as Activity;
    expect(a).toEqual({ newReviews: 3, averageRating: 4.5, unreplied: 2, postsPublished: 1 });
  });

  it("returns zeros and a null average for a quiet scope", async () => {
    const a = (await run(o.owner, "performance.activity", {
      locationIds: [o.locAOff.id],
      ...range,
    })) as Activity;
    expect(a).toEqual({ newReviews: 0, averageRating: null, unreplied: 0, postsPublished: 0 });
  });

  it("is scoped like performance.summary", async () => {
    expect(
      await codeOf(run(o.viewerB, "performance.activity", { workspaceId: o.wsA, ...range })),
    ).toMatch(/^(NOT_FOUND|FORBIDDEN)/);
    expect(
      await codeOf(run(other.owner, "performance.activity", { locationIds: [o.locA1.id], ...range })),
    ).toMatch(/^NOT_FOUND/);
  });

  it("every role that can open /performance (report:read) can also read the panel (review:read)", () => {
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      if (perms.includes("report:read")) expect(perms, role).toContain("review:read");
    }
  });
});
