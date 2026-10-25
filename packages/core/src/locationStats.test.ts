import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, profileChanges, reviews, suspensionCases } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit, uniq, type Loc, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const { run } = kit;

type Stats = {
  locationId: string;
  reviews: { total: number; avgRating: number | null; unreplied: number; waitingToPublish: number };
  openChanges: number;
  suspensionOpen: boolean;
};
type Out = { locations: Stats[] };

let org: Org;
let l1: Loc; // A: 3 reviews, 2 open changes, no case
let l2: Loc; // A: appealed suspension case
let l3: Loc; // B: reinstated case only
let l4: Loc; // A: inactive, nothing at all
let seq = 0;

async function review(loc: Loc, rating: number | null, reply: { comment?: string; state?: string } = {}) {
  const t = new Date();
  await db.insert(reviews).values({
    orgId: loc.row.orgId,
    workspaceId: loc.row.workspaceId,
    locationId: loc.row.id,
    googleReviewName: `${loc.row.googleAccountName}/${loc.row.googleLocationId}/reviews/st-${uniq()}-${seq++}`,
    starRating: rating,
    createTime: t,
    updateTime: t,
    replyComment: reply.comment ?? null,
    replyState: reply.state ?? null,
  });
}

async function change(loc: Loc, status: "open" | "accepted") {
  await db.insert(profileChanges).values({
    orgId: loc.row.orgId,
    locationId: loc.row.id,
    source: "nightly",
    fieldPaths: ["websiteUri"],
    before: { websiteUri: "https://a.example" },
    after: { websiteUri: "https://b.example" },
    status,
  });
}

async function suspension(loc: Loc, status: "open" | "appealed" | "reinstated") {
  await db.insert(suspensionCases).values({
    orgId: loc.row.orgId,
    locationId: loc.row.id,
    reason: "Suspended after an address edit",
    status,
    evidenceChecklist: [],
    createdBy: org.ownerId,
  });
}

const byId = (out: Out, id: string) => out.locations.find((l) => l.locationId === id);

beforeAll(async () => {
  org = await kit.makeOrg();
  l1 = await org.mkLoc(org.a);
  l2 = await org.mkLoc(org.a);
  l3 = await org.mkLoc(org.b);
  l4 = await org.mkLoc(org.a, { status: "inactive" });
  await review(l1, 5, { comment: "Thank you!" });
  await review(l1, 4);
  await review(l1, 2, { comment: "Sorry to hear that.", state: "REJECTED" });
  await review(l1, null); // unrated: counted in total, not in the average
  await change(l1, "open");
  await change(l1, "open");
  await change(l1, "accepted");
  await suspension(l2, "appealed");
  await suspension(l3, "reinstated");
});

afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

describe("locations.stats", () => {
  it("counts reviews, unreplied, open changes and open suspension cases per location (canary)", async () => {
    const out = await run<Out>(org.owner, "locations.stats", {});
    const ours = out.locations.filter((l) => [l1, l2, l3, l4].some((x) => x.row.id === l.locationId));
    console.log(`locations.stats: ${out.locations.length} locations, ${ours.length} from this test`);
    expect(ours).toHaveLength(4);

    const s1 = byId(out, l1.row.id)!;
    expect(s1.reviews.total).toBe(4);
    expect(s1.reviews.avgRating).toBeCloseTo((5 + 4 + 2) / 3, 5);
    // No reply (4 stars, unrated) plus the Google-REJECTED reply.
    expect(s1.reviews.unreplied).toBe(3);
    expect(s1.openChanges).toBe(2);
    expect(s1.suspensionOpen).toBe(false);

    expect(byId(out, l2.row.id)!.suspensionOpen).toBe(true);
    expect(byId(out, l3.row.id)!.suspensionOpen).toBe(false);
  });

  it("a location with nothing synced has zeros and a null average", async () => {
    const out = await run<Out>(org.owner, "locations.stats", { locationIds: [l4.row.id] });
    expect(out.locations).toEqual([
      {
        locationId: l4.row.id,
        reviews: { total: 0, avgRating: null, unreplied: 0, waitingToPublish: 0 },
        openChanges: 0,
        suspensionOpen: false,
      },
    ]);
  });

  it("filters by workspace and by ids", async () => {
    const b = await run<Out>(org.owner, "locations.stats", { workspaceId: org.b });
    expect(b.locations.map((l) => l.locationId)).toEqual([l3.row.id]);
    const ids = await run<Out>(org.owner, "locations.stats", { locationIds: [l2.row.id, l1.row.id] });
    expect(ids.locations.map((l) => l.locationId).sort()).toEqual([l1.row.id, l2.row.id].sort());
  });

  it("scope: a client viewer of A never sees B, even by id; asking for B is FORBIDDEN", async () => {
    const out = await run<Out>(org.viewerA, "locations.stats", { locationIds: [l3.row.id, l1.row.id] });
    expect(out.locations.map((l) => l.locationId)).toEqual([l1.row.id]);
    expect(await codeOf(run(org.viewerA, "locations.stats", { workspaceId: org.b }))).toBe("FORBIDDEN");
  });

  it("rejects more than 500 ids", async () => {
    const many = Array.from({ length: 501 }, () => crypto.randomUUID());
    expect(await codeOf(run(org.owner, "locations.stats", { locationIds: many }))).toBe("INVALID_INPUT");
  });
});
