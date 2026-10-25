import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, googleRateWindows, postTargets, reviewSyncs, reviews, suspensionCases, users } from "@opengmb/db";
import { writeAudit } from "./audit";
import { localParts } from "./time/format";
import type { Actor } from "./actor";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit, uniq, type Loc, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const { run } = kit;

type Overview = {
  location: {
    id: string;
    name: string;
    workspaceId: string;
    workspaceName: string;
    addressSummary: string | null;
    status: "active" | "inactive";
    needsRelink: boolean;
  };
  stats: { reviews: { total: number; avgRating: number | null; unreplied: number }; openChanges: number; suspensionOpen: boolean };
  lastPost: { publishedAt: string; summary: string; createdSurface: string } | null;
  changeSets: {
    id: string;
    status: "pending_approval" | "approved";
    fieldNames: string[];
    locationCount: number;
    createdSurface: string;
    createdByName: string | null;
  }[];
  suspension: { id: string; status: string; openedAt: string; evidenceDone: number; evidenceTotal: number } | null;
  syncs: { reviewsPending: boolean; lastReviewSyncAt: string | null; performanceBackfillPending: boolean };
  activity: { at: string; text: string; surface: string | null }[];
  google: {
    checkedAt: string;
    health: { passed: number; total: number; percent: number };
    verification: { standing: string; hasVoiceOfMerchant: boolean } | null;
    profile: { primaryCategory: string | null; hoursToday: string | null; openNow: boolean | null; phone: string | null; website: string | null } | null;
    photos: { count: number; newestDays: number | null; items: { category: string | null; thumbnailUrl: string | null }[] } | null;
    bookingLinks: { uri: string; type: string; preferred: boolean }[] | null;
    lastPostAt: string | null;
  } | null;
};
type Health = { score: { passed: number; total: number; percent: number } };

let org: Org;
let seq = 0;
const tok = () => Math.random().toString(36).slice(2, 10).replace(/\d/g, "q");
const overview = (loc: Loc, actor: Actor = org.owner) =>
  run<Overview>(actor, "locations.overview", { locationId: loc.row.id });

async function proposeTitle(actor: Actor, loc: Loc) {
  const fields = { title: `Clinic ${tok()}` };
  const p = await run<{ locations: { locationId: string; current: unknown }[] }>(actor, "profile.preview", {
    locationIds: [loc.row.id],
    fields,
  });
  const out = await run<{ changeSet: { id: string; status: string } }>(actor, "profile.propose", {
    workspaceId: loc.row.workspaceId,
    locationIds: [loc.row.id],
    fields,
    snapshots: p.locations.map((l) => ({ locationId: l.locationId, current: l.current })),
  });
  return out.changeSet.id;
}

beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  setSharedMockGoogleClient(mock);
  org = await kit.makeOrg();
  await db.update(users).set({ name: "Marcus" }).where(eq(users.id, org.manager.userId));
});
// One org makes many Google reads across the tests: start each with an empty org rate window.
beforeEach(async () => {
  await db.delete(googleRateWindows).where(eq(googleRateWindows.bucketKey, `org:${org.orgId}`));
});
afterAll(async () => {
  setSharedMockGoogleClient(null);
  await kit.deactivateAll();
  await sql.end();
});

describe("locations.overview", () => {
  it("a linked active location: DB facts plus one Google pass; the score equals locations.healthcheck (canary)", async () => {
    const loc = await org.mkLoc(org.a);
    const o = await overview(loc);
    const h = await run<Health>(org.owner, "locations.healthcheck", { locationId: loc.row.id });
    console.log(`overview: health ${JSON.stringify(o.google?.health)}, activity ${o.activity.length}`);
    expect(o.location).toMatchObject({ id: loc.row.id, name: loc.row.name, workspaceId: org.a, workspaceName: "A", status: "active", needsRelink: false });
    expect(o.google).not.toBeNull();
    expect(o.google!.health).toEqual(h.score);
    expect(o.google!.verification?.standing).toBe("good_standing");
    expect(o.google!.profile?.phone).toBeTruthy();
    // The mock's default hours are Monday to Friday 09:00 to 17:00.
    const weekday = new Date().getUTCDay(); // makeOrg workspaces are UTC
    expect(o.google!.profile?.hoursToday).toBe(weekday >= 1 && weekday <= 5 ? "09:00 to 17:00" : null);
    expect(o.google!.photos?.count).toBeTypeOf("number");
    expect(Array.isArray(o.google!.bookingLinks)).toBe(true);
    expect(o.stats.reviews.total).toBe(0);
    expect(o.lastPost).toBeNull();
    expect(o.changeSets).toEqual([]);
    expect(o.suspension).toBeNull();
    expect(o.syncs).toEqual({ reviewsPending: false, lastReviewSyncAt: null, performanceBackfillPending: false });
  });

  it("hours and openNow are read in the workspace's time zone, not UTC", async () => {
    // UTC+14 and UTC-11 are on different calendar days for 25 of every 24 hours, so at least one
    // of them disagrees with the UTC weekday at any moment.
    for (const timeZone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      await run(org.owner, "workspaces.setTimeSettings", { workspaceId: org.b, timeZone });
      const loc = await org.mkLoc(org.b);
      const o = await overview(loc);
      const weekday = localParts(new Date(), timeZone).weekday;
      expect(o.google!.profile?.hoursToday, timeZone).toBe(weekday >= 1 && weekday <= 5 ? "09:00 to 17:00" : null);
      expect(typeof o.google!.profile?.openNow).toBe("boolean");
    }
  });

  it("change sets that target the location, with who and how; an agent's carries surface mcp", async () => {
    const loc = await org.mkLoc(org.a);
    const mcp: Actor = { ...org.manager, surface: "mcp", actorType: "api_token" };
    // profile.propose has no "one open change set per location" guard (actions/profile.ts:355-415), so two can wait at once.
    const byHand = await proposeTitle(org.manager, loc);
    const byAgent = await proposeTitle(mcp, loc);
    const o = await overview(loc);
    expect(o.changeSets.map((c) => c.id)).toEqual([byHand, byAgent]);
    expect(o.changeSets[0]).toMatchObject({ status: "pending_approval", fieldNames: ["title"], locationCount: 1, createdSurface: "ui", createdByName: "Marcus" });
    expect(o.changeSets[1]!.createdSurface).toBe("mcp");
    expect(o.activity.some((a) => a.text.startsWith("Marcus proposed a profile change: title") && a.surface === "mcp")).toBe(true);
  });

  it("last published post, activity newest first, at most 5 items", async () => {
    const loc = await org.mkLoc(org.a);
    for (let i = 0; i < 3; i++) {
      const { post } = await run<{ post: { id: string } }>(org.manager, "posts.createDraft", {
        workspaceId: org.a,
        locationIds: [loc.row.id],
        topicType: "STANDARD",
        summary: `Weekly back-care tip ${i}`,
      });
      await db
        .update(postTargets)
        .set({ status: "published", publishedAt: new Date(Date.UTC(2026, 9, 10 + i, 14)) })
        .where(eq(postTargets.postId, post.id));
    }
    await proposeTitle(org.manager, loc);
    await proposeTitle(org.manager, loc);
    await proposeTitle(org.manager, loc);
    const o = await overview(loc);
    expect(o.lastPost?.summary).toBe("Weekly back-care tip 2");
    expect(o.lastPost?.publishedAt).toBe("2026-10-12T14:00:00.000Z");
    expect(o.activity).toHaveLength(5);
    const times = o.activity.map((a) => a.at);
    expect(times).toEqual([...times].sort().reverse());
    expect(o.activity.filter((a) => a.text.startsWith("Post published: Weekly back-care tip"))).toHaveLength(2);
  });

  it("sync state, suspension and review stats come from SynGMB's tables", async () => {
    const loc = await org.mkLoc(org.a);
    await db.insert(reviewSyncs).values({ orgId: org.orgId, locationId: loc.row.id, status: "pending" });
    await db.insert(reviewSyncs).values({ orgId: org.orgId, locationId: loc.row.id, status: "done", finishedAt: new Date("2026-10-13T08:00:00Z") });
    await db.insert(suspensionCases).values({
      orgId: org.orgId,
      locationId: loc.row.id,
      reason: "Suspended after an address edit",
      status: "open",
      openedAt: new Date("2026-10-09T10:00:00Z"),
      evidenceChecklist: [
        { key: "a", label: "A", done: true, note: "" },
        { key: "b", label: "B", done: false, note: "" },
      ],
      createdBy: org.ownerId,
    });
    const t = new Date();
    await db.insert(reviews).values({
      orgId: org.orgId,
      workspaceId: org.a,
      locationId: loc.row.id,
      googleReviewName: `${loc.parent}/reviews/ov-${uniq()}-${seq++}`,
      starRating: 5,
      createTime: t,
      updateTime: t,
    });
    const o = await overview(loc);
    // No backfill was requested for this location, so none is "queued" (a missing snapshot alone proves nothing).
    expect(o.syncs).toEqual({ reviewsPending: true, lastReviewSyncAt: "2026-10-13T08:00:00.000Z", performanceBackfillPending: false });
    // Through writeAudit (hash chain), exactly as locations/import.ts records it.
    await db.transaction((tx) =>
      writeAudit(tx, {
        orgId: org.orgId,
        actorUserId: null,
        actorType: "system",
        surface: "worker",
        action: "performance.backfill_requested",
        entityType: "location",
        entityId: loc.row.id,
        before: null,
        after: { trigger: "test" },
      }),
    );
    expect((await overview(loc)).syncs.performanceBackfillPending).toBe(true);
    expect(o.suspension).toMatchObject({ status: "open", openedAt: "2026-10-09T10:00:00.000Z", evidenceDone: 1, evidenceTotal: 2 });
    expect(o.stats).toMatchObject({ reviews: { total: 1, avgRating: 5, unreplied: 1 }, suspensionOpen: true });
  });

  it("inactive and not-linked locations skip Google entirely", async () => {
    const inactive = await org.mkLoc(org.a, { status: "inactive" });
    const orphan = await org.mkLoc(org.a, { connectionId: null });
    const a = await overview(inactive);
    const b = await overview(orphan);
    expect(a.google).toBeNull();
    expect(a.location.status).toBe("inactive");
    expect(b.google).toBeNull();
    expect(b.location.needsRelink).toBe(true);
  });

  it("scope: a client viewer of A reads A, and gets NOT_FOUND for B", async () => {
    const inA = await org.mkLoc(org.a);
    const inB = await org.mkLoc(org.b);
    expect((await overview(inA, org.viewerA)).location.id).toBe(inA.row.id);
    expect(await codeOf(overview(inB, org.viewerA))).toBe("NOT_FOUND");
  });
});
