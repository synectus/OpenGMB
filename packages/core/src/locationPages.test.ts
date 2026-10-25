// packages/core/src/locationPages.test.ts
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb, googleMedia, googlePosts, locations, profileSnapshots, reviewLinks, reviews, workspaceReplySettings } from "@opengmb/db";
import { eq } from "drizzle-orm";
import { MockGoogleClient } from "./google/mock-client";
import { locationPageData } from "./location-pages/public";
import { localBusinessJsonLd } from "./location-pages/pure";
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

type Page = { slug: string; path: string; published: boolean; publishedAt: string | null };
let n = 0;
async function setup() {
  const org = await kit.makeOrg();
  const loc = await org.mkLoc(org.a, { addressSummary: "1 Main St, Springfield" });
  await db.insert(profileSnapshots).values({
    orgId: org.orgId, locationId: loc.row.id, source: "nightly", hash: uniq(),
    data: {
      fields: {
        title: "Acme Dental", description: "Family dentistry.", websiteUri: "https://acme.test/",
        categories: { primaryCategory: { name: "categories/gcid:dentist" }, additionalCategories: [] },
        regularHours: { periods: [{ openDay: "MONDAY", openTime: { hours: 9 }, closeDay: "MONDAY", closeTime: { hours: 17 } }] },
        serviceItems: [{ freeFormServiceItem: { category: "x", label: { displayName: "Teeth whitening" } } }],
        phoneNumbers: { primaryPhone: "+1 555 010 0100" },
      },
      attributes: {},
    },
  });
  return { org, loc };
}
const set = (org: Org, loc: Loc, published: boolean) => kit.run<Page>(org.owner, "locationPages.set", { locationId: loc.row.id, published });
const addReview = (org: Org, loc: Loc, o: { rating: number; comment: string | null }) =>
  db.insert(reviews).values({
    orgId: org.orgId, workspaceId: org.a, locationId: loc.row.id, googleReviewName: `accounts/1/locations/2/reviews/${uniq()}-${n++}`,
    reviewerDisplayName: "Dana Whitfield", starRating: o.rating, comment: o.comment, createTime: new Date(), updateTime: new Date(),
  });

describe("locationPageData photos", () => {
  it("renders with no photos; otherwise newest first, https only, capped at 12, alt from description or category", async () => {
    const { org, loc } = await setup();
    const p = await set(org, loc, true);
    expect((await locationPageData(db, p.slug))!.data.photos).toEqual([]);
    const m = (i: number, extra: Partial<typeof googleMedia.$inferInsert> = {}) => ({
      orgId: org.orgId, locationId: loc.row.id, googleMediaName: `m/${uniq()}`, googleUrl: `https://img.test/${i}.jpg`,
      googleCreatedAt: new Date(Date.UTC(2026, 0, 1 + i)), ...extra,
    });
    await db.insert(googleMedia).values([
      ...Array.from({ length: 14 }, (_, i) => m(i)),
      m(20, { googleUrl: "http://insecure.test/x.jpg" }),
      m(21, { googleCreatedAt: null, googleUrl: "https://img.test/undated.jpg" }),
      m(30, { googleUrl: "https://img.test/desc.jpg", description: "The  front desk", googleCreatedAt: new Date(Date.UTC(2026, 5, 1)) }),
      m(31, { googleUrl: "https://img.test/cat.jpg", category: "FOOD_AND_DRINK", googleCreatedAt: new Date(Date.UTC(2026, 5, 2)) }),
    ]);
    const photos = (await locationPageData(db, p.slug))!.data.photos;
    expect(photos).toHaveLength(12);
    expect(photos[0]).toEqual({ url: "https://img.test/cat.jpg", alt: "Acme Dental, food and drink photo" });
    expect(photos[1]).toEqual({ url: "https://img.test/desc.jpg", alt: "The front desk" });
    expect(photos[2]!.alt).toBe("Photo of Acme Dental");
    expect(photos[2]!.url).toBe("https://img.test/13.jpg");
    expect(photos.some((x) => x.url.startsWith("http://") || x.url.includes("undated"))).toBe(false);
  });
});

describe("locationPages.set and locationPageData", () => {
  it("is off by default; publishing serves the data with valid JSON-LD; unpublishing returns null", async () => {
    const { org, loc } = await setup();
    expect((await kit.run<{ page: Page | null }>(org.owner, "locationPages.get", { locationId: loc.row.id })).page).toBeNull();
    const p = await set(org, loc, true);
    expect(p).toMatchObject({ published: true, path: `/l/${p.slug}` });
    await addReview(org, loc, { rating: 5, comment: "Wonderful" });
    await addReview(org, loc, { rating: 2, comment: "Slow" });
    await addReview(org, loc, { rating: 5, comment: null });
    await db.insert(googlePosts).values([
      { orgId: org.orgId, locationId: loc.row.id, googlePostName: `p/${uniq()}`, topicType: "STANDARD", state: "LIVE", summary: "Spring offer", mediaUrl: "https://img.test/a.jpg", ctaUrl: "javascript:alert(1)" },
      { orgId: org.orgId, locationId: loc.row.id, googlePostName: `p/${uniq()}`, topicType: "STANDARD", state: "REJECTED", summary: "Rejected one" },
    ]);
    const got = (await locationPageData(db, p.slug))!;
    expect(got).not.toBeNull();
    const d = got.data;
    expect(d).toMatchObject({ name: "Acme Dental", description: "Family dentistry.", categories: ["Dentist"], address: "1 Main St, Springfield", phone: "+1 555 010 0100", website: "https://acme.test/", services: ["Teeth whitening"], reviewCount: 3 });
    expect(d.reviews.map((r) => r.text)).toEqual(["Wonderful"]);
    expect(d.reviews[0]!.name).toBe("Dana W.");
    expect(d.posts).toEqual([{ summary: "Spring offer", imageUrl: "https://img.test/a.jpg", linkUrl: null }]);
    expect(d.hours[0]).toEqual({ day: "Monday", text: "9:00 AM to 5:00 PM" });
    const ld = localBusinessJsonLd(d, `https://app.test${p.path}`, got.regularHours);
    expect(ld).toMatchObject({ "@type": "LocalBusiness", name: "Acme Dental", telephone: "+1 555 010 0100", aggregateRating: { reviewCount: 3 } });
    expect(JSON.parse(JSON.stringify(ld))).toEqual(ld);

    await set(org, loc, false);
    expect(await locationPageData(db, p.slug)).toBeNull();
    const again = await set(org, loc, true);
    expect(again.slug).toBe(p.slug);
    expect(await locationPageData(db, p.slug)).not.toBeNull();
    expect(await kit.auditRows(org.orgId, "location_page.published")).toHaveLength(2);
    expect(await kit.auditRows(org.orgId, "location_page.unpublished")).toHaveLength(1);
  });
  it("an inactive location, a malformed slug and an unknown slug are all null", async () => {
    const { org, loc } = await setup();
    const p = await set(org, loc, true);
    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, loc.row.id));
    expect(await locationPageData(db, p.slug)).toBeNull();
    expect(await locationPageData(db, "../x")).toBeNull();
    expect(await locationPageData(db, `nope-${uniq()}`)).toBeNull();
  });
  it("review text follows the widget rules: healthcare workspaces and badge links show a rating only", async () => {
    const { org, loc } = await setup();
    const p = await set(org, loc, true);
    await addReview(org, loc, { rating: 5, comment: "Lovely" });
    expect((await locationPageData(db, p.slug))!.data.reviews).toHaveLength(1);
    await db.insert(workspaceReplySettings).values({ orgId: org.orgId, workspaceId: org.a, profile: "healthcare", packs: ["hipaa"] }).onConflictDoNothing();
    const d = (await locationPageData(db, p.slug))!.data;
    expect(d.reviews).toEqual([]);
    expect(d.reviewCount).toBe(1);
    await db.insert(reviewLinks).values({ orgId: org.orgId, workspaceId: org.a, locationId: loc.row.id, slug: `rl-${uniq()}`.slice(0, 40), googlePlaceId: "ChIJ-test-place-id_1", widgetLayout: "grid" });
    expect((await locationPageData(db, p.slug))!.data.reviews).toHaveLength(1);
  });
  it("needs location:manage to publish; clients can read, other workspaces see nothing", async () => {
    const { org, loc } = await setup();
    expect(await codeOf(kit.run(org.approverA, "locationPages.set", { locationId: loc.row.id, published: true }))).toBe("FORBIDDEN");
    await set(org, loc, true);
    expect((await kit.run<{ page: Page }>(org.approverA, "locationPages.get", { locationId: loc.row.id })).page.published).toBe(true);
    expect(await codeOf(kit.run(org.approverB, "locationPages.get", { locationId: loc.row.id }))).toMatch(/NOT_FOUND|FORBIDDEN/);
  });
});
