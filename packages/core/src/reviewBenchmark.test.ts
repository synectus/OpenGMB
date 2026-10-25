import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb, gridCompetitorSnapshots, reviews } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit, uniq, type Loc, type Org } from "./testkit";

// R9: the benchmark renders from stored K2 competitor snapshots; own numbers come from synced reviews.
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
  locationId: string;
  dataSource: "fixture" | "sandbox" | "live" | null;
  snapshotDate: string | null;
  own: { name: string; reviewCount: number; rating: number | null; last30Days: number };
  competitors: {
    placeId: string;
    title: string;
    reviewCount: number | null;
    rating: number | null;
    appearances: number;
    averageRank: number;
    velocity: { perThirtyDays: number; fromDay: string; toDay: string } | null;
  }[];
};

async function setup() {
  const org = await kit.makeOrg();
  const loc = await org.mkLoc(org.a);
  const created = await kit.run<{ config: { id: string } }>(org.manager, "geogrid.configs.create", {
    locationId: loc.row.id,
    keywords: ["emergency dentist"],
    gridSize: 3,
    radiusM: 3000,
    centerLat: 29.4241,
    centerLng: -98.4936,
  });
  return { org, loc, configId: created.config.id };
}

const snap = (
  org: Org,
  loc: Loc,
  configId: string,
  o: { placeId: string; day: string; source?: "fixture" | "sandbox" | "live"; appearances: number; avgRank: string; reviews: number | null; rating?: string },
) =>
  db.insert(gridCompetitorSnapshots).values({
    orgId: org.orgId,
    configId,
    locationId: loc.row.id,
    keyword: "emergency dentist",
    placeId: o.placeId,
    title: `Biz ${o.placeId}`,
    snapshotDate: o.day,
    dataSource: o.source ?? "fixture",
    appearances: o.appearances,
    avgRank: o.avgRank,
    bestRank: 1,
    rating: o.rating ?? "4.5",
    reviewCount: o.reviews,
  });

const review = (org: Org, loc: Loc, ws: string, rating: number, at: Date) =>
  db.insert(reviews).values({
    orgId: org.orgId,
    workspaceId: ws,
    locationId: loc.row.id,
    googleReviewName: `accounts/1/locations/2/reviews/${uniq()}`,
    starRating: rating,
    createTime: at,
    updateTime: at,
  });

describe("reviews.competitorBenchmark", () => {
  it("sample and live data are never mixed: live wins, own numbers come from reviews", async () => {
    const { org, loc, configId } = await setup();
    const now = Date.now();
    await review(org, loc, org.a, 5, new Date(now - 2 * 86_400_000));
    await review(org, loc, org.a, 4, new Date(now - 10 * 86_400_000));
    await review(org, loc, org.a, 3, new Date(now - 90 * 86_400_000));
    for (const [id, app, rank, count] of [
      ["p1", 9, "2.00", 300],
      ["p2", 9, "3.00", 200],
      ["p3", 7, "1.00", 120],
      ["p4", 2, "1.00", 999],
    ] as const) {
      await snap(org, loc, configId, { placeId: id, day: "2026-10-24", appearances: app, avgRank: rank, reviews: count });
    }
    // p1 gained 30 reviews over 30 days; p3 has no earlier snapshot.
    await snap(org, loc, configId, { placeId: "p1", day: "2026-09-24", appearances: 9, avgRank: "2.00", reviews: 270 });
    await snap(org, loc, configId, { placeId: "p2", day: "2026-10-24", source: "live", appearances: 1, avgRank: "9.00", reviews: 5 }); // other source, newest-day tie: live wins below

    const out = await kit.run<Out>(org.owner, "reviews.competitorBenchmark", { locationId: loc.row.id });
    expect(out.own).toMatchObject({ reviewCount: 3, rating: 4, last30Days: 2 });
    // The live row on the newest day makes live the source: only that one row is benchmarked, never mixed with fixture.
    expect(out.dataSource).toBe("live");
    expect(out.competitors.map((c) => c.placeId)).toEqual(["p2"]);
    expect(out.competitors[0]!.velocity).toBeNull();
  });

  it("fixture data: top 3, not-enough-history is null velocity, history gives per-30-day velocity", async () => {
    const { org, loc, configId } = await setup();
    for (const [id, app, rank, count] of [
      ["p1", 9, "2.00", 300],
      ["p2", 9, "3.00", 200],
      ["p3", 7, "1.00", 120],
      ["p4", 2, "1.00", 999],
    ] as const) {
      await snap(org, loc, configId, { placeId: id, day: "2026-10-24", appearances: app, avgRank: rank, reviews: count });
    }
    await snap(org, loc, configId, { placeId: "p1", day: "2026-09-24", appearances: 9, avgRank: "2.00", reviews: 270 });
    const out = await kit.run<Out>(org.owner, "reviews.competitorBenchmark", { locationId: loc.row.id });
    expect(out.dataSource).toBe("fixture");
    expect(out.snapshotDate).toBe("2026-10-24");
    expect(out.competitors.map((c) => c.placeId)).toEqual(["p1", "p2", "p3"]);
    expect(out.competitors[0]).toMatchObject({ reviewCount: 300, rating: 4.5, velocity: { perThirtyDays: 30, fromDay: "2026-09-24", toDay: "2026-10-24" } });
    expect(out.competitors[1]!.velocity).toBeNull();
    expect(out.own).toMatchObject({ reviewCount: 0, rating: null });
  });

  it("a location with no tracker snapshots has an empty benchmark", async () => {
    const { org, loc } = await setup();
    const out = await kit.run<Out>(org.owner, "reviews.competitorBenchmark", { locationId: loc.row.id });
    expect(out).toMatchObject({ dataSource: null, snapshotDate: null, competitors: [] });
  });

  it("another client's location is not found for a scoped member", async () => {
    const { org } = await setup();
    const other = await org.mkLoc(org.b);
    expect(await codeOf(kit.run(org.approverA, "reviews.competitorBenchmark", { locationId: other.row.id }))).toMatch(/FORBIDDEN|NOT_FOUND/);
  });
});
