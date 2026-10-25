// packages/core/src/reviewLinks.test.ts
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, reviewLinkClicks, reviewLinks, reviews, workspaceReplySettings } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { resolveReviewLink, widgetData } from "./review-links/public";
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

const PLACE = "ChIJ-test-place-id_1";
type Got = {
  link: null | { slug: string; trackedPath: string; googleReviewUrl: string; widget: { enabled: boolean; minRating: number; layout: string; note: string } };
  clicks30d: { link: number; qr: number; sms: number; email: number; total: number };
  newReviews30d: number;
  summary: { avgRating: number | null; count: number };
  workspaceProfile: string;
};

async function setup() {
  const org = await kit.makeOrg();
  const loc = await org.mkLoc(org.a);
  return { org, loc };
}
const save = (org: Org, loc: Loc, extra: object = {}) =>
  kit.run<{ slug: string; created: boolean }>(org.owner, "reviewLinks.save", { locationId: loc.row.id, placeId: PLACE, ...extra });
let n = 0;
const addReview = (org: Org, loc: Loc, o: { rating: number; comment: string | null; name?: string; anon?: boolean; ageDays?: number }) =>
  db.insert(reviews).values({
    orgId: org.orgId, workspaceId: org.a, locationId: loc.row.id,
    googleReviewName: `accounts/1/locations/2/reviews/${uniq()}-${n++}`,
    reviewerDisplayName: o.name ?? "Dana Whitfield", reviewerIsAnonymous: o.anon ?? false,
    starRating: o.rating, comment: o.comment,
    createTime: new Date(Date.now() - (o.ageDays ?? 1) * 86_400_000), updateTime: new Date(),
  });

describe("reviewLinks.save and reviewLinks.get", () => {
  it("creates one link per location, then updates it", async () => {
    const { org, loc } = await setup();
    const first = await save(org, loc);
    expect(first.created).toBe(true);
    const again = await save(org, loc, { widgetEnabled: true, widgetMinRating: 1, widgetLayout: "carousel" });
    expect(again).toEqual({ slug: first.slug, created: false });
    const got = await kit.run<Got>(org.owner, "reviewLinks.get", { locationId: loc.row.id });
    expect(got.link).toMatchObject({ slug: first.slug, trackedPath: `/go/${first.slug}`, googleReviewUrl: `https://search.google.com/local/writereview?placeid=${PLACE}`, widget: { enabled: true, minRating: 1, layout: "carousel" } });
    expect(got.link!.widget.note).not.toMatch(/\ball\b/i);
    expect(await kit.auditRows(org.orgId, "review_link.created")).toHaveLength(1);
    expect(await kit.auditRows(org.orgId, "review_link.updated")).toHaveLength(1);
  });
  it("needs a valid place id to create", async () => {
    const { org, loc } = await setup();
    expect(await codeOf(kit.run(org.owner, "reviewLinks.save", { locationId: loc.row.id }))).toBe("INVALID_INPUT");
    expect(await codeOf(kit.run(org.owner, "reviewLinks.save", { locationId: loc.row.id, placeId: "nope" }))).toBe("INVALID_INPUT");
  });
  it("a healthcare workspace starts with the badge-only layout", async () => {
    const { org, loc } = await setup();
    await db.insert(workspaceReplySettings).values({ orgId: org.orgId, workspaceId: org.a, profile: "healthcare", packs: ["hipaa"] }).onConflictDoNothing();
    await save(org, loc);
    const got = await kit.run<Got>(org.owner, "reviewLinks.get", { locationId: loc.row.id });
    expect(got.workspaceProfile).toBe("healthcare");
    expect(got.link!.widget.layout).toBe("badge");
  });
  it("a client can read but not create; another workspace's client sees nothing", async () => {
    const { org, loc } = await setup();
    expect(await codeOf(kit.run(org.approverA, "reviewLinks.save", { locationId: loc.row.id, placeId: PLACE }))).toBe("FORBIDDEN");
    await save(org, loc);
    expect((await kit.run<Got>(org.approverA, "reviewLinks.get", { locationId: loc.row.id })).link).not.toBeNull();
    expect(await codeOf(kit.run(org.approverB, "reviewLinks.get", { locationId: loc.row.id }))).toMatch(/NOT_FOUND|FORBIDDEN/);
  });
  it("without a link, get returns null and no crash when Google gives no suggestion", async () => {
    const { org, loc } = await setup();
    const got = await kit.run<Got & { suggestedPlaceId: string | null }>(org.owner, "reviewLinks.get", { locationId: loc.row.id });
    expect(got.link).toBeNull();
    expect(got.clicks30d.total).toBe(0);
  });
  it("30-day clicks per source ignore older days; new reviews and the summary come from synced reviews", async () => {
    const { org, loc } = await setup();
    const { slug } = await save(org, loc);
    const [link] = await db.select().from(reviewLinks).where(eq(reviewLinks.slug, slug));
    const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
    await db.insert(reviewLinkClicks).values([
      { orgId: org.orgId, linkId: link!.id, day: day(2), source: "qr", count: 5 },
      { orgId: org.orgId, linkId: link!.id, day: day(10), source: "link", count: 3 },
      { orgId: org.orgId, linkId: link!.id, day: day(45), source: "link", count: 100 },
    ]);
    await addReview(org, loc, { rating: 5, comment: "great", ageDays: 3 });
    await addReview(org, loc, { rating: 3, comment: "ok", ageDays: 90 });
    const got = await kit.run<Got>(org.owner, "reviewLinks.get", { locationId: loc.row.id });
    expect(got.clicks30d).toEqual({ link: 3, qr: 5, sms: 0, email: 0, total: 8 });
    expect(got.newReviews30d).toBe(1);
    expect(got.summary).toEqual({ avgRating: 4, count: 2 });
  });
});

describe("resolveReviewLink", () => {
  it("redirects to Google, counts by source, and skips bots", async () => {
    const { org, loc } = await setup();
    const { slug } = await save(org, loc);
    expect(await resolveReviewLink(db, slug, { source: "qr", count: true })).toBe(`https://search.google.com/local/writereview?placeid=${PLACE}`);
    await resolveReviewLink(db, slug, { source: "qr", count: true });
    await resolveReviewLink(db, slug, { source: "sms", count: true });
    await resolveReviewLink(db, slug, { source: "link", count: false });
    const got = await kit.run<Got>(org.owner, "reviewLinks.get", { locationId: loc.row.id });
    expect(got.clicks30d).toEqual({ link: 0, qr: 2, sms: 1, email: 0, total: 3 });
  });
  it("unknown or malformed slug is null and counts nothing", async () => {
    expect(await resolveReviewLink(db, "no-such-link-" + uniq(), { source: "link", count: true })).toBeNull();
    expect(await resolveReviewLink(db, "../etc/passwd", { source: "link", count: true })).toBeNull();
  });
});

describe("widgetData", () => {
  it("is null until the owner turns it on, and identical for unknown slugs", async () => {
    const { org, loc } = await setup();
    const { slug } = await save(org, loc);
    expect(await widgetData(db, slug)).toBeNull();
    expect(await widgetData(db, "no-such-link-" + uniq())).toBeNull();
  });
  it("shows the minimum rating, short names, clipped text, and nothing internal", async () => {
    const { org, loc } = await setup();
    const { slug } = await save(org, loc, { widgetEnabled: true, widgetMinRating: 4, widgetLayout: "grid" });
    await addReview(org, loc, { rating: 5, comment: "Friendly team " + "x".repeat(400), name: "Dana Whitfield" });
    await addReview(org, loc, { rating: 4, comment: "Good care", anon: true });
    await addReview(org, loc, { rating: 2, comment: "SECRET-LOW-REVIEW" });
    await addReview(org, loc, { rating: 5, comment: null });
    const w = (await widgetData(db, slug))!;
    expect(w.note).toBe("Showing reviews rated 4★ and up · from Google");
    expect(w.count).toBe(4);
    expect(w.reviews.map((r) => r.rating).sort()).toEqual([4, 5]);
    expect(w.reviews.find((r) => r.rating === 5)!.name).toBe("Dana W.");
    expect(w.reviews.find((r) => r.rating === 4)!.name).toBe("A Google user");
    expect(w.reviews.every((r) => r.text.length <= 240)).toBe(true);
    const json = JSON.stringify(w);
    expect(json).not.toMatch(/SECRET-LOW-REVIEW|Whitfield|orgId|workspaceId|locationId|placeId/);
  });
  it("badge layout carries no review text", async () => {
    const { org, loc } = await setup();
    const { slug } = await save(org, loc, { widgetEnabled: true, widgetLayout: "badge" });
    await addReview(org, loc, { rating: 5, comment: "text" });
    expect((await widgetData(db, slug))!.reviews).toEqual([]);
  });
});
