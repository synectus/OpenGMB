import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb, locations, reviews } from "@opengmb/db";
import { eq } from "drizzle-orm";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit, uniq, type Loc, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

type Out = {
  current: { count: number; avgRating: number | null; replied: number; replyRate: number | null; medianReplyHours: number | null; needsReply: number };
  previous: { count: number; avgRating: number | null };
  months: { month: string }[];
  locations: { name: string; count: number }[];
  truncated: boolean;
};

let n = 0;
const add = (org: Org, loc: Loc, ws: string, o: { at: string; rating?: number | null; reply?: { at: string; state?: string } }) =>
  db.insert(reviews).values({
    orgId: org.orgId,
    workspaceId: ws,
    locationId: loc.row.id,
    googleReviewName: `accounts/1/locations/2/reviews/${uniq()}-${n++}`,
    reviewerDisplayName: "SECRET-NAME",
    starRating: o.rating === undefined ? 5 : o.rating,
    comment: "SECRET-COMMENT my diabetes",
    createTime: new Date(o.at),
    updateTime: new Date(o.at),
    replyComment: o.reply ? "SECRET-REPLY" : null,
    replyUpdateTime: o.reply ? new Date(o.reply.at) : null,
    replyState: o.reply ? (o.reply.state ?? "APPROVED") : null,
  });

const WINDOW = { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" };

async function seeded() {
  const org = await kit.makeOrg();
  const a = await org.mkLoc(org.a);
  const b = await org.mkLoc(org.b);
  await add(org, a, org.a, { at: "2026-09-02T00:00:00Z", rating: 5, reply: { at: "2026-09-02T10:00:00Z" } });
  await add(org, a, org.a, { at: "2026-09-03T00:00:00Z", rating: 4, reply: { at: "2026-09-04T06:00:00Z" } });
  await add(org, a, org.a, { at: "2026-09-04T00:00:00Z", rating: 1 });
  await add(org, a, org.a, { at: "2026-08-10T00:00:00Z", rating: 4 }); // previous window (30 days before)
  await add(org, a, org.a, { at: "2026-08-11T00:00:00Z", rating: 4 });
  await add(org, b, org.b, { at: "2026-09-05T00:00:00Z", rating: 3 });
  return { org, a, b };
}

describe("reviews.analytics", () => {
  it("canary: known reviews give known numbers, previous window of equal length", async () => {
    const { org } = await seeded();
    const out = await kit.run<Out>(org.owner, "reviews.analytics", { workspaceId: org.a, ...WINDOW });
    expect(out.current).toMatchObject({ count: 3, avgRating: 3.3, replied: 2, needsReply: 1, medianReplyHours: 20 });
    expect(out.current.replyRate).toBeCloseTo(2 / 3, 5);
    expect(out.previous).toMatchObject({ count: 2, avgRating: 4 });
    expect(out.months.map((m) => m.month)).toEqual(["2026-09"]);
    expect(out.truncated).toBe(false);
  });

  it("a reply Google rejected counts as needing a reply (same rule as the inbox)", async () => {
    const org = await kit.makeOrg();
    const a = await org.mkLoc(org.a);
    await add(org, a, org.a, { at: "2026-09-02T00:00:00Z", reply: { at: "2026-09-02T01:00:00Z", state: "REJECTED" } });
    const out = await kit.run<Out>(org.owner, "reviews.analytics", { workspaceId: org.a, ...WINDOW });
    expect(out.current).toMatchObject({ count: 1, replied: 0, needsReply: 1 });
  });

  it("never returns review text, reviewer names or reply text", async () => {
    const { org } = await seeded();
    const out = await kit.run<Out>(org.owner, "reviews.analytics", WINDOW);
    expect(JSON.stringify(out)).not.toMatch(/SECRET/);
  });

  it("a client approver sees only their workspace, and cannot ask for another", async () => {
    const { org } = await seeded();
    const own = await kit.run<Out>(org.approverA, "reviews.analytics", WINDOW);
    expect(own.current.count).toBe(3);
    expect(await codeOf(kit.run(org.approverA, "reviews.analytics", { workspaceId: org.b, ...WINDOW }))).toMatch(/FORBIDDEN|NOT_FOUND/);
  });

  it("inactive locations are left out", async () => {
    const { org, a } = await seeded();
    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, a.row.id));
    const out = await kit.run<Out>(org.owner, "reviews.analytics", { workspaceId: org.a, ...WINDOW });
    expect(out.current.count).toBe(0);
  });

  it("an empty window is zeros, not an error", async () => {
    const org = await kit.makeOrg();
    const out = await kit.run<Out>(org.owner, "reviews.analytics", WINDOW);
    expect(out.current).toMatchObject({ count: 0, avgRating: null, replyRate: null });
    expect(out.locations).toEqual([]);
  });

  it("rejects an empty or too long range", async () => {
    const org = await kit.makeOrg();
    expect(await codeOf(kit.run(org.owner, "reviews.analytics", { from: WINDOW.to, to: WINDOW.from }))).toBe("INVALID_INPUT");
    expect(await codeOf(kit.run(org.owner, "reviews.analytics", { from: "2020-01-01T00:00:00Z", to: "2026-10-01T00:00:00Z" }))).toBe("INVALID_INPUT");
  });
});
