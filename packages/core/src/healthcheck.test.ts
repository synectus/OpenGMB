import { randomInt } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  auditLog,
  createDb,
  googleRateWindows,
  locationGroupMembers,
  locationGroups,
  locations,
  memberships,
  organizations,
  reviews,
  searchKeywordsMonthly,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor } from "./actor";
import { GOOGLE_LIMITS } from "./config/google-limits";
import { HEALTHCHECK_CONFIG } from "./config/healthcheck";
import { executeAction } from "./executor";
import { seedMockGoogleConnection } from "./google/dev-seed";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const uniqDigits = () => `${Date.now()}${randomInt(100_000_000, 1_000_000_000)}`;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

type Check = {
  id: string;
  importance: string;
  status: string;
  detail: string;
  fix: { label: string; href: string } | null;
};
type Health = {
  location: { id: string; name: string; workspaceId: string };
  score: { passed: number; total: number; percent: number };
  checks: Check[];
  checkedAt: string;
};
type Summary = {
  locations: {
    locationId: string;
    name: string;
    score: { passed: number; total: number; percent: number };
    failingNecessary: number;
    failing: { id: string; title: string; importance: string }[];
    checkedAt: string;
  }[];
  total: number;
};

async function makeOrg() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const orgId = org!.id;
  const [a, b] = await db
    .insert(workspaces)
    .values([
      { orgId, name: "A" },
      { orgId, name: "B" },
    ])
    .returning();
  const mkUser = async (role: "owner" | "client_viewer", workspaceId?: string) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId, userId: id, role, workspaceId });
    return { id, email: `${id}@example.test` };
  };
  const owner = await mkUser("owner");
  const actor = (u: { id: string }) =>
    loadActor(db, { userId: u.id, surface: "ui", actorType: "user" });
  const { connectionId } = await seedMockGoogleConnection(db, owner.email);
  /** A location row plus a matching location in the mock Google. */
  const mkLoc = async (
    workspaceId: string,
    extra: Partial<typeof locations.$inferInsert> = {},
    inMock = true,
  ) => {
    const n = uniqDigits().slice(-12);
    const name = `locations/7${n}`;
    if (inMock) mock.addLocation({ name, title: `Clinic ${n}` });
    const [l] = await db
      .insert(locations)
      .values({
        orgId,
        workspaceId,
        name: `Clinic ${n}`,
        googleAccountName: "accounts/100000000000000000001",
        googleLocationId: name,
        connectionId,
        phone: "+1 555 010 0199",
        ...extra,
      })
      .returning();
    return { row: l!, google: name, parent: `accounts/100000000000000000001/${name}` };
  };
  return {
    orgId,
    a: a!.id,
    b: b!.id,
    owner: await actor(owner),
    viewerA: await actor(await mkUser("client_viewer", a!.id)),
    mkLoc,
  };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;

let org: Org;
const run = <T>(actor: Org["owner"], name: string, input: unknown = {}) =>
  executeAction(db, actor, name, input) as Promise<T>;
const health = (locationId: string, actor = org.owner) =>
  run<Health>(actor, "locations.healthcheck", { locationId });
const get = (h: Health, id: string) => h.checks.find((c) => c.id === id)!;

let seq = 0;
async function addReview(
  locationId: string,
  workspaceId: string,
  over: Partial<typeof reviews.$inferInsert> = {},
) {
  const createTime = over.createTime ?? daysAgo(1);
  await db.insert(reviews).values({
    orgId: org.orgId,
    workspaceId,
    locationId,
    googleReviewName: `accounts/1/locations/2/reviews/hc-${uniq()}-${seq++}`,
    starRating: 5,
    createTime,
    updateTime: createTime,
    ...over,
  });
}

beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  setSharedMockGoogleClient(mock);
  org = await makeOrg();
});
// One org makes many Google reads across the tests: start each with an empty org rate window.
beforeEach(async () => {
  await db.delete(googleRateWindows).where(eq(googleRateWindows.bucketKey, `org:${org.orgId}`));
});
afterAll(async () => {
  setSharedMockGoogleClient(null);
  await sql.end();
});

describe("locations.healthcheck", () => {
  it("fresh mock location: profile checks read from Google, score counts pass and fail", async () => {
    const loc = await org.mkLoc(org.a);
    const h = await health(loc.row.id);
    console.log(`healthcheck: ${h.checks.length} checks, score ${JSON.stringify(h.score)}`);
    expect(h.location).toEqual({ id: loc.row.id, name: loc.row.name, workspaceId: org.a });
    expect(h.checks.length).toBeGreaterThanOrEqual(19);
    expect(get(h, "phone").status).toBe("pass");
    expect(get(h, "primary_category").status).toBe("pass");
    expect(get(h, "regular_hours").status).toBe("pass");
    expect(get(h, "website").status).toBe("pass");
    expect(get(h, "description").status).toBe("fail");
    expect(get(h, "verification").status).toBe("pass");
    expect(get(h, "recent_post").status).toBe("fail");
    expect(get(h, "recent_post").fix?.href).toBe("/posts?view=compose");
    const counted = h.checks.filter((c) => c.status !== "unknown");
    expect(h.score.total).toBe(counted.length);
    expect(h.score.passed).toBe(counted.filter((c) => c.status === "pass").length);
    expect(Number.isNaN(Date.parse(h.checkedAt))).toBe(false);
  });

  it("a complete listing: profile edits, photos, a post and reviews turn checks green", async () => {
    const loc = await org.mkLoc(org.a);
    mock.editLocation(
      loc.google,
      {
        profile: { description: "A friendly clinic serving the neighbourhood." },
        categories: {
          primaryCategory: { name: "categories/gcid:dentist" },
          additionalCategories: [{ name: "categories/gcid:orthodontist" }],
        },
        websiteUri: "https://example.test/?utm_source=google",
        serviceItems: [
          { freeFormServiceItem: { category: "c", label: { displayName: "Cleaning" } } },
        ],
      },
      ["profile", "categories", "websiteUri", "serviceItems"],
    );
    for (const category of ["PROFILE", "COVER", ...Array(9).fill("ADDITIONAL")]) {
      await mock.createMedia(loc.parent, {
        mediaFormat: "PHOTO",
        sourceUrl: "https://example.test/p.jpg",
        locationAssociation: { category },
      });
    }
    await mock.createLocalPost(loc.parent, { topicType: "STANDARD", summary: "Hello" });
    await addReview(loc.row.id, org.a, { replyComment: "Thanks", replyState: "APPROVED" });
    const h = await health(loc.row.id);
    for (const id of [
      "description",
      "additional_categories",
      "website_utm",
      "service_items",
      "photo_count",
      "recent_photo",
      "logo_photo",
      "cover_photo",
      "recent_post",
      "unreplied_reviews",
      "average_rating",
      "new_reviews",
    ]) {
      expect(get(h, id), id).toMatchObject({ status: "pass", fix: null });
    }
  });

  it("reviews: unreplied counts no reply and Google-REJECTED replies, only inside the window", async () => {
    const loc = await org.mkLoc(org.a);
    const ws = org.a;
    await addReview(loc.row.id, ws, { starRating: 5, replyComment: "ok", replyState: "APPROVED" });
    expect(get(await health(loc.row.id), "unreplied_reviews").status).toBe("pass");

    await addReview(loc.row.id, ws, { starRating: 1, createTime: daysAgo(60) }); // old, unreplied
    expect(get(await health(loc.row.id), "unreplied_reviews").status).toBe("pass");

    await addReview(loc.row.id, ws, { starRating: 3 });
    const one = get(await health(loc.row.id), "unreplied_reviews");
    expect(one.status).toBe("fail");
    expect(one.detail).toContain("1 review ");
    expect(one.fix?.href).toBe(`/reviews?replied=no&loc=${loc.row.id}`);

    await addReview(loc.row.id, ws, { replyComment: "x", replyState: "REJECTED" });
    expect(get(await health(loc.row.id), "unreplied_reviews").detail).toContain("2 reviews");
  });

  it("reviews: average over all synced reviews, unknown with none", async () => {
    const loc = await org.mkLoc(org.a);
    const none = await health(loc.row.id);
    expect(get(none, "average_rating").status).toBe("unknown");
    expect(get(none, "new_reviews").status).toBe("fail");
    const withUnknown = none.checks.filter((c) => c.status === "unknown").length;
    expect(none.score.total).toBe(none.checks.length - withUnknown);

    await addReview(loc.row.id, org.a, { starRating: 5, createTime: daysAgo(90) });
    await addReview(loc.row.id, org.a, { starRating: 2, createTime: daysAgo(90) });
    const h = await health(loc.row.id);
    expect(get(h, "average_rating").status).toBe("fail"); // 3.5
    expect(get(h, "average_rating").detail).toContain("3.5");
    expect(get(h, "new_reviews").status).toBe("fail");
  });

  it("one failing Google read makes only its checks unknown", async () => {
    const loc = await org.mkLoc(org.a);
    mock.failNext(1, () => new Error("boom"), "listLocalPosts");
    const h = await health(loc.row.id);
    expect(get(h, "recent_post").status).toBe("unknown");
    expect(get(h, "phone").status).toBe("pass");
    expect(get(h, "photo_count").status).toBe("fail");
    // The failed read, plus average_rating (no reviews synced) description_keywords (no search keywords stored) and category_fit (no competitor data stored).
    expect(
      h.checks
        .filter((c) => c.status === "unknown")
        .map((c) => c.id)
        .sort(),
    ).toEqual(["average_rating", "category_fit", "description_keywords", "recent_post"]);
    expect(h.score.total).toBe(h.checks.length - 4);
  });

  it("an org over its Google limit: checks are unknown with the limit message, not 'Could not read'", async () => {
    const loc = await org.mkLoc(org.a);
    const windowMs = GOOGLE_LIMITS.orgFairUse.windowMs;
    await db.insert(googleRateWindows).values({
      bucketKey: `org:${org.orgId}`,
      windowStart: new Date(Math.floor(Date.now() / windowMs) * windowMs),
      count: GOOGLE_LIMITS.orgFairUse.limit,
    });
    const h = await health(loc.row.id);
    const google = h.checks.filter((c) => c.status === "unknown" && c.id !== "average_rating");
    expect(google.length).toBeGreaterThanOrEqual(6);
    for (const c of google) {
      expect(c.detail).toMatch(/^Google request limit for your account reached, try again in \d+ minutes?\.$/);
    }
    expect(h.checks.some((c) => c.detail.includes("Could not read"))).toBe(false);
  });

  it("a location missing on Google: every Google check is unknown, review checks still run", async () => {
    const loc = await org.mkLoc(org.a, {}, false);
    const h = await health(loc.row.id);
    expect(get(h, "description").status).toBe("unknown");
    expect(get(h, "verification").status).toBe("unknown");
    expect(get(h, "unreplied_reviews").status).toBe("pass");
  });

  it("an unlinked location is all-unknown on Google rather than an error", async () => {
    const loc = await org.mkLoc(org.a, {
      googleLocationId: null,
      googleAccountName: null,
      connectionId: null,
    });
    const h = await health(loc.row.id);
    expect(get(h, "verification").status).toBe("unknown");
    expect(get(h, "unreplied_reviews").status).toBe("pass");
  });

  it("scope: a client viewer reads their own workspace only; another workspace is NOT_FOUND", async () => {
    const mine = await org.mkLoc(org.a);
    const other = await org.mkLoc(org.b);
    expect((await health(mine.row.id, org.viewerA)).location.id).toBe(mine.row.id);
    await expect(health(other.row.id, org.viewerA)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("locations.healthcheckSummary", () => {
  it("sorts worst first with failingNecessary, and honours workspace scope", async () => {
    const o = await makeOrg();
    const good = await o.mkLoc(o.a);
    const bad = await o.mkLoc(o.a);
    const other = await o.mkLoc(o.b);
    // `bad` loses its phone and category on Google.
    mock.editLocation(bad.google, { phoneNumbers: {}, categories: {} }, [
      "phoneNumbers",
      "categories",
    ]);
    // Make `good` better than `bad`: it has a recent post.
    await mock.createLocalPost(good.parent, { topicType: "STANDARD", summary: "Hi" });
    // Not in the summary: inactive and unlinked.
    await o.mkLoc(o.a, { status: "inactive" });
    await o.mkLoc(o.a, { googleLocationId: null, googleAccountName: null, connectionId: null });

    const all = await executeAction(db, o.owner, "locations.healthcheckSummary", {});
    const s = all as Summary;
    console.log(`summary: ${s.locations.length} of ${s.total}`);
    expect(s.total).toBe(3);
    expect(s.locations.map((l) => l.locationId).sort()).toEqual(
      [good.row.id, bad.row.id, other.row.id].sort(),
    );
    const percents = s.locations.map((l) => l.score.percent);
    expect(percents).toEqual([...percents].sort((x, y) => x - y));
    expect(s.locations.findIndex((l) => l.locationId === bad.row.id)).toBeLessThan(
      s.locations.findIndex((l) => l.locationId === good.row.id),
    );
    const badRow = s.locations.find((l) => l.locationId === bad.row.id)!;
    const goodRow = s.locations.find((l) => l.locationId === good.row.id)!;
    expect(badRow.failingNecessary).toBe(goodRow.failingNecessary + 2);
    expect(badRow.name).toBe(bad.row.name);

    const ws = (await executeAction(db, o.owner, "locations.healthcheckSummary", {
      workspaceId: o.b,
    })) as Summary;
    expect(ws.locations.map((l) => l.locationId)).toEqual([other.row.id]);

    const client = (await executeAction(
      db,
      o.viewerA,
      "locations.healthcheckSummary",
      {},
    )) as Summary;
    expect(client.locations.map((l) => l.locationId).sort()).toEqual(
      [good.row.id, bad.row.id].sort(),
    );
    await expect(
      executeAction(db, o.viewerA, "locations.healthcheckSummary", { workspaceId: o.b }),
    ).rejects.toBeTruthy();
  });

  it("each location lists its failing checks, necessary first, and when it was checked", async () => {
    const o = await makeOrg();
    const bad = await o.mkLoc(o.a);
    mock.editLocation(bad.google, { phoneNumbers: {} }, ["phoneNumbers"]);
    const s = (await executeAction(db, o.owner, "locations.healthcheckSummary", {})) as Summary;
    const row = s.locations.find((l) => l.locationId === bad.row.id)!;
    const single = await run<Health>(o.owner, "locations.healthcheck", { locationId: bad.row.id });
    const expected = single.checks.filter((c) => c.status === "fail");
    console.log(`summary failing: ${row.failing.length}`);
    expect(row.failing.length).toBe(expected.length);
    expect(row.failing.length).toBeGreaterThan(0);
    expect(row.failing.map((f) => f.id).sort()).toEqual(expected.map((c) => c.id).sort());
    expect(row.failing[0]!.importance).toBe("necessary"); // phone is necessary and failing
    const rank = { necessary: 0, important: 1, nice: 2 } as const;
    const order = row.failing.map((f) => rank[f.importance as keyof typeof rank]);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(Number.isNaN(Date.parse(row.checkedAt))).toBe(false);
  });

  it("runs one page of locations, first by name, and the offset reaches the rest (U8)", async () => {
    const o = await makeOrg();
    // A small page keeps the test inside the Google read budget (about 7 reads a location); the
    // rule is the same at any size.
    const cfg = HEALTHCHECK_CONFIG as { summaryPageSize: number };
    const real = cfg.summaryPageSize;
    cfg.summaryPageSize = 3;
    try {
      for (let i = 0; i < 5; i++) await o.mkLoc(o.a);
      const page1 = (await executeAction(db, o.owner, "locations.healthcheckSummary", {})) as Summary;
      const page2 = (await executeAction(db, o.owner, "locations.healthcheckSummary", { offset: 3 })) as Summary;
      console.log(`summary pages: ${page1.locations.length} + ${page2.locations.length} of ${page1.total}`);
      expect(page1.total).toBe(5);
      expect(page1.locations).toHaveLength(3);
      expect(page2.total).toBe(5);
      expect(page2.locations).toHaveLength(2);
      const ids = [...page1.locations, ...page2.locations].map((l) => l.locationId);
      expect(new Set(ids).size).toBe(5); // every location exactly once
      const past = (await executeAction(db, o.owner, "locations.healthcheckSummary", { offset: 5 })) as Summary;
      expect(past.locations).toHaveLength(0);
    } finally {
      cfg.summaryPageSize = real;
    }
    expect(real).toBeGreaterThan(3);
  });

  it("locationIds narrows what is paged, so a group or location scope pages within itself (U8)", async () => {
    const o = await makeOrg();
    const picked = [await o.mkLoc(o.a), await o.mkLoc(o.a)];
    await o.mkLoc(o.a);
    const s = (await executeAction(db, o.owner, "locations.healthcheckSummary", {
      locationIds: picked.map((p) => p.row.id),
    })) as Summary;
    expect(s.total).toBe(2);
    expect(s.locations.map((l) => l.locationId).sort()).toEqual(picked.map((p) => p.row.id).sort());
  });
});

describe("locations.healthcheckSummary groupId (H4)", () => {
  it("pages within a group of any size: the server resolves the members, so no id list hits the 500 cap", async () => {
    const o = await makeOrg();
    const picked = [await o.mkLoc(o.a), await o.mkLoc(o.a)];
    await o.mkLoc(o.a); // linked, not in the group
    const [g] = await db.insert(locationGroups).values({ orgId: o.orgId, workspaceId: o.a, name: `Big ${randomInt(1e9)}` }).returning();
    // 600 unlinked locations in the group (not checked, but members), so the group is past 500 ids.
    const fill = await db
      .insert(locations)
      .values(Array.from({ length: 600 }, (_, i) => ({ orgId: o.orgId, workspaceId: o.a, name: `Unlinked ${randomInt(1e9)}-${i}`, status: "active" as const })))
      .returning({ id: locations.id });
    const members = [...picked.map((p) => p.row.id), ...fill.map((f) => f.id)];
    for (let i = 0; i < members.length; i += 300) {
      await db.insert(locationGroupMembers).values(members.slice(i, i + 300).map((locationId) => ({ groupId: g!.id, locationId, orgId: o.orgId })));
    }
    expect(members.length).toBeGreaterThan(500);
    const s = (await executeAction(db, o.owner, "locations.healthcheckSummary", { groupId: g!.id })) as Summary;
    expect(s.total).toBe(2);
    expect(s.locations.map((l) => l.locationId).sort()).toEqual(picked.map((p) => p.row.id).sort());
    await expect(
      executeAction(db, o.owner, "locations.healthcheckSummary", { groupId: g!.id, locationIds: [picked[0]!.row.id] }),
    ).rejects.toBeTruthy();
  });
});

describe("locations.healthcheck L7 stored-data checks", () => {
  it("description_keywords reads stored Performance keywords", async () => {
    const loc = await org.mkLoc(org.a, { name: "Ace Dental", addressSummary: "12 Main St, Austin TX" });
    const now = new Date();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
    // No stored keywords yet: unknown, not pass.
    expect(get(await health(loc.row.id), "description_keywords").status).toBe("unknown");
    await db.insert(searchKeywordsMonthly).values([
      { orgId: org.orgId, locationId: loc.row.id, month, keyword: "emergency dentist zzq", value: 90, threshold: null },
      { orgId: org.orgId, locationId: loc.row.id, month, keyword: "hidden term", value: null, threshold: 15 },
    ]);
    const k = get(await health(loc.row.id), "description_keywords");
    console.log(`L7 keywords check: ${k.status} (${k.detail})`);
    expect(k.status).toBe("fail");
    expect(k.detail).toContain("emergency dentist zzq");
    expect(k.detail).not.toContain("hidden term");
  });
  it("category_fit is unknown, never pass or fail, with no competitor data stored", async () => {
    const loc = await org.mkLoc(org.a, { name: "Cedar Dental", addressSummary: "3 Elm St, Austin TX" });
    const c = get(await health(loc.row.id), "category_fit");
    console.log(`L7b category_fit without competitor data: ${c.status} (${c.detail})`);
    expect(c.status).toBe("unknown");
    expect(c.detail).toContain("Not enough competitor data");
  });
  it("duplicate_listing sees only the caller's own scope", async () => {
    const loc = await org.mkLoc(org.a, { name: "Birch Optical", addressSummary: "7 Oak Rd, Leeds" });
    expect(get(await health(loc.row.id), "duplicate_listing").status).toBe("pass");
    const twinA = await org.mkLoc(org.a, { name: "Birch Optical Clinic", addressSummary: "7 Oak Road, Leeds" });
    const twinB = await org.mkLoc(org.b, { name: "Birch Optical Clinic", addressSummary: "7 Oak Road, Leeds" });
    const own = get(await health(loc.row.id), "duplicate_listing");
    expect(own.status).toBe("fail");
    expect(own.fix?.href).toContain("/locations/");
    // A viewer of workspace A never learns about the workspace B twin: only twin A is named.
    const viewer = await health(loc.row.id, org.viewerA);
    expect(get(viewer, "duplicate_listing").fix?.href).toBe(`/locations/${twinA.row.id}/profile`);
    expect(twinB.row.id).not.toBe(twinA.row.id);
  });
});

describe("locations.healthcheckSkip", () => {
  it("skip leaves the check out of every score; undo brings it back; audited", async () => {
    const o = await makeOrg();
    const loc = await o.mkLoc(o.a);
    const before = await run<Health>(o.owner, "locations.healthcheck", { locationId: loc.row.id });
    const failing = before.checks.find((c) => c.status === "fail")!;
    expect(failing).toBeTruthy();

    await run(o.owner, "locations.healthcheckSkip", {
      locationId: loc.row.id,
      checkId: failing.id,
      skipped: true,
    });
    const after = await run<Health>(o.owner, "locations.healthcheck", { locationId: loc.row.id });
    const c = after.checks.find((x) => x.id === failing.id)!;
    console.log(`skip: total ${before.score.total} -> ${after.score.total}`);
    expect(c.status).toBe("skipped");
    expect((c as unknown as { skipped: { byName: string | null; at: string } }).skipped.byName).toBe("T");
    expect(after.score.total).toBe(before.score.total - 1);
    expect(after.score.passed).toBe(before.score.passed);

    const summary = (await executeAction(db, o.owner, "locations.healthcheckSummary", {})) as Summary;
    const row = summary.locations.find((l) => l.locationId === loc.row.id)!;
    expect(row.score).toEqual(after.score);
    expect(row.failing.map((f) => f.id)).not.toContain(failing.id);

    const ov = await run<{ google: { health: Health["score"] } }>(o.owner, "locations.overview", {
      locationId: loc.row.id,
    });
    expect(ov.google.health).toEqual(after.score);

    // Skipping twice is idempotent; undo restores.
    await run(o.owner, "locations.healthcheckSkip", {
      locationId: loc.row.id,
      checkId: failing.id,
      skipped: true,
    });
    await run(o.owner, "locations.healthcheckSkip", {
      locationId: loc.row.id,
      checkId: failing.id,
      skipped: false,
    });
    const undone = await run<Health>(o.owner, "locations.healthcheck", { locationId: loc.row.id });
    expect(undone.score).toEqual(before.score);

    const audits = await db.select().from(auditLog).where(eq(auditLog.orgId, o.orgId));
    expect(audits.filter((a) => a.action === "location.healthcheck_skip")).toHaveLength(2);
    expect(audits.filter((a) => a.action === "location.healthcheck_unskip")).toHaveLength(1);
  });

  it("rejects unknown check ids and client roles", async () => {
    const o = await makeOrg();
    const loc = await o.mkLoc(o.a);
    const code = async (p: Promise<unknown>) =>
      p.then(
        () => "no error",
        (e: { code?: string }) => e.code ?? "other",
      );
    expect(
      await code(run(o.owner, "locations.healthcheckSkip", { locationId: loc.row.id, checkId: "nope", skipped: true })),
    ).toBe("INVALID_INPUT");
    expect(
      await code(run(o.viewerA, "locations.healthcheckSkip", { locationId: loc.row.id, checkId: "phone", skipped: true })),
    ).toBe("FORBIDDEN");
  });
});
