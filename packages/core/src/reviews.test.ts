import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  auditLog,
  createDb,
  locationGroupMembers,
  locationGroups,
  locations,
  memberships,
  organizations,
  googleMedia,
  googlePosts,
  reviews,
  reviewSyncs,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { verifyAuditChain } from "./audit";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { seedMockGoogleConnection } from "./google/dev-seed";
import { MockGoogleClient } from "./google/mock-client";
import type { ReplyPolicyReview } from "./reviews/reply-policy";
import { failReviewSync, processReviewSync, REVIEW_SYNC_QUEUE } from "./reviews/sync";

// The bulk tool's skip handling needs a policy that skips something; today's policy allows all.
const policy = vi.hoisted(() => ({ skipFiveStar: false }));
vi.mock("./reviews/reply-policy", async (orig) => {
  const real = await orig<typeof import("./reviews/reply-policy")>();
  return {
    ...real,
    replyPolicy: (r: ReplyPolicyReview, w: Parameters<typeof real.replyPolicy>[1]) =>
      policy.skipFiveStar && r.starRating === 5
        ? { replyAllowed: false, skipReason: "test_skip" }
        : real.replyPolicy(r, w),
  };
});

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// Digits only, for Google ids (`locations/7<digits>`): the timestamp plus 9 random digits, so two files
// minting an id in the same millisecond cannot collide (stripping letters from uniq() could).
const uniqDigits = () => `${Date.now()}${randomInt(100_000_000, 1_000_000_000)}`;
const SECRET = "my back pain and my diabetes after the accident, Dr Smith";

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? e.code : `other:${String(e)}`;
  }
  return "no error";
}

type Item = {
  id: string;
  googleReviewName: string;
  location: { id: string; name: string };
  rating: number | null;
  comment: string | null;
  createTime: string;
  reply: {
    comment: string;
    updateTime: string | null;
    state?: string | null;
    policyViolation?: string | null;
  } | null;
  replyAllowed?: boolean;
  skipReason?: string | null;
};
type ListOut = { items: Item[]; nextCursor: string | null };
type UnrepliedOut = { items: Item[]; totalReturned: number; nextCursor: string | null };

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
  const mkUser = async (
    role: "owner" | "manager" | "client_approver" | "client_viewer",
    workspaceId?: string,
  ) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId, userId: id, role, workspaceId });
    return { id, email: `${id}@example.test` };
  };
  const owner = await mkUser("owner");
  const manager = await mkUser("manager");
  const viewer = await mkUser("client_viewer", a!.id);
  const approver = await mkUser("client_approver", a!.id);
  const actor = (u: { id: string }, surface: Actor["surface"] = "ui") =>
    loadActor(db, { userId: u.id, surface, actorType: "user" });
  const { connectionId } = await seedMockGoogleConnection(db, owner.email);
  const mkLoc = async (
    workspaceId: string,
    name: string,
    status: "active" | "inactive" = "active",
  ) => {
    const n = uniqDigits();
    const [l] = await db
      .insert(locations)
      .values({
        orgId,
        workspaceId,
        name,
        googleAccountName: `accounts/9${n.slice(-8)}`,
        googleLocationId: `locations/9${n.slice(-10)}`,
        connectionId,
        status,
      })
      .returning();
    return l!;
  };
  return {
    orgId,
    a: a!.id,
    b: b!.id,
    owner: await actor(owner),
    manager: await actor(manager),
    viewer: await actor(viewer),
    approver: await actor(approver),
    mkLoc,
  };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;

const run = (actor: Actor, name: string, input: unknown = {}) =>
  executeAction(db, actor, name, input);

let seq = 0;
/** Insert a review straight into the table (filter tests need exact timestamps). */
async function mkReview(
  loc: { id: string; orgId: string; workspaceId: string },
  o: {
    rating?: number | null;
    reply?: string | null;
    createTime?: string;
    comment?: string | null;
  } = {},
) {
  const createTime = new Date(o.createTime ?? "2026-09-01T00:00:00Z");
  const [r] = await db
    .insert(reviews)
    .values({
      orgId: loc.orgId,
      workspaceId: loc.workspaceId,
      locationId: loc.id,
      googleReviewName: `accounts/1/locations/1/reviews/t${uniq()}-${seq++}`,
      reviewerDisplayName: "Rev",
      starRating: o.rating === undefined ? 5 : o.rating,
      comment: o.comment === undefined ? "text" : o.comment,
      createTime,
      updateTime: createTime,
      replyComment: o.reply ?? null,
      replyUpdateTime: o.reply ? createTime : null,
    })
    .returning();
  return r!;
}

/** Page through reviews.list until exhausted; returns all items in order. */
async function listAll(actor: Actor, input: Record<string, unknown>, limit = 25) {
  const items: Item[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 200; i++) {
    const r = (await run(actor, "reviews.list", { ...input, limit, cursor })) as ListOut;
    items.push(...r.items);
    if (!r.nextCursor) return items;
    cursor = r.nextCursor;
  }
  throw new Error("cursor never ended");
}

beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  await boss.start();
  await boss.createQueue(REVIEW_SYNC_QUEUE);
});
afterAll(async () => {
  await boss.stop();
  await sql.end();
});

describe("reviews.sync action and job", () => {
  let org: Org;
  const mock = new MockGoogleClient();
  let l1: Awaited<ReturnType<Org["mkLoc"]>>;
  let l2: Awaited<ReturnType<Org["mkLoc"]>>;
  let off: Awaited<ReturnType<Org["mkLoc"]>>;

  beforeAll(async () => {
    org = await makeOrg();
    l1 = await org.mkLoc(org.a, "Clinic One");
    l2 = await org.mkLoc(org.a, "Clinic Two");
    off = await org.mkLoc(org.a, "Closed Clinic", "inactive");
    for (let i = 0; i < 3; i++) {
      mock.addReview(l1.googleAccountName!, l1.googleLocationId!, {
        starRating: "ONE",
        comment: SECRET,
        reviewerName: "Pat Q",
      });
    }
    mock.addReview(l1.googleAccountName!, l1.googleLocationId!, { starRating: "FIVE" });
    mock.addReview(l2.googleAccountName!, l2.googleLocationId!, {
      starRating: "FOUR",
      reply: "Thanks",
    });
    mock.addReview(off.googleAccountName!, off.googleLocationId!, { starRating: "FIVE" });
  });

  const syncAll = async (actor: Actor, input: Record<string, unknown>) => {
    const out = (await run(actor, "reviews.sync", input)) as {
      syncs: { syncId: string; locationId: string; jobId: string }[];
      skipped: { locationId: string; reason: string }[];
    };
    const counts = [];
    for (const s of out.syncs) counts.push(await processReviewSync(db, s.syncId, { client: mock }));
    return { ...out, counts };
  };

  it("queues one job and one review_syncs row per active location, audited, nothing fetched yet", async () => {
    const calls = mock.callCount;
    const out = (await run(org.manager, "reviews.sync", { workspaceId: org.a })) as {
      syncs: { syncId: string; locationId: string; jobId: string }[];
      skipped: unknown[];
    };
    expect(out.syncs.map((s) => s.locationId).sort()).toEqual([l1.id, l2.id].sort());
    expect(out.skipped).toEqual([]);
    const jobs =
      await sql`select id from pgboss.job where id = any(${out.syncs.map((s) => s.jobId)})`;
    expect(jobs).toHaveLength(2);
    expect(mock.callCount).toBe(calls);
    const rows = await db
      .select()
      .from(reviewSyncs)
      .where(
        inArray(
          reviewSyncs.id,
          out.syncs.map((s) => s.syncId),
        ),
      );
    expect(rows.every((r) => r.status === "pending" && r.requestedBy === org.manager.userId)).toBe(
      true,
    );
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.action, "review_sync.requested")));
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits.every((a) => a.surface === "ui")).toBe(true);
    // settle them so later tests start clean
    for (const s of out.syncs) await processReviewSync(db, s.syncId, { client: mock });
  });

  it("permissions: review:draft needed, workspace must be in the org and the actor's scope", async () => {
    expect(await codeOf(run(org.viewer, "reviews.sync", { workspaceId: org.a }))).toBe("FORBIDDEN");
    expect(await codeOf(run(org.approver, "reviews.sync", { workspaceId: org.a }))).toBe(
      "FORBIDDEN",
    );
    const other = await makeOrg();
    expect(await codeOf(run(org.owner, "reviews.sync", { workspaceId: other.a }))).toBe(
      "NOT_FOUND",
    );
    // a workspace with no active locations
    expect(await codeOf(run(org.owner, "reviews.sync", { workspaceId: org.b }))).toBe("NOT_FOUND");
  });

  it("inactive and foreign locations are skipped by the action, not queued", async () => {
    const other = await makeOrg();
    const foreign = await other.mkLoc(other.a, "Other org");
    const out = (await run(org.owner, "reviews.sync", {
      workspaceId: org.a,
      locationIds: [l1.id, off.id, foreign.id],
    })) as {
      syncs: { syncId: string; locationId: string }[];
      skipped: { locationId: string; reason: string }[];
    };
    expect(out.syncs.map((s) => s.locationId)).toEqual([l1.id]);
    expect(out.skipped.sort((x, y) => (x.reason < y.reason ? -1 : 1))).toEqual(
      [
        { locationId: off.id, reason: "inactive" },
        { locationId: foreign.id, reason: "not_found" },
      ].sort((x, y) => (x.reason < y.reason ? -1 : 1)),
    );
    await processReviewSync(db, out.syncs[0]!.syncId, { client: mock });
  });

  it("the job upserts reviews and records counts; syncStatus reports them", async () => {
    await db.delete(reviews).where(eq(reviews.orgId, org.orgId));
    const out = await syncAll(org.owner, { workspaceId: org.a });
    expect(out.counts.map((c) => [c!.fetched, c!.inserted, c!.updated]).sort()).toEqual([
      [1, 1, 0],
      [4, 4, 0],
    ]);
    const stored = await db.select().from(reviews).where(eq(reviews.locationId, l1.id));
    expect(stored).toHaveLength(4);
    expect(stored.map((r) => r.starRating).sort()).toEqual([1, 1, 1, 5]);
    expect(stored.every((r) => r.orgId === org.orgId && r.workspaceId === org.a)).toBe(true);
    const status = (await run(org.viewer, "reviews.syncStatus", {
      syncIds: out.syncs.map((s) => s.syncId),
    })) as {
      syncs: { status: string; counts: { fetched: number } | null; locationName: string }[];
    };
    expect(status.syncs.map((s) => s.status)).toEqual(["done", "done"]);
    expect(status.syncs.map((s) => s.counts?.fetched).sort()).toEqual([1, 4]);
    // a settled sync is not processed twice
    expect(await processReviewSync(db, out.syncs[0]!.syncId, { client: mock })).toBeNull();
  });

  it("is idempotent on re-run", async () => {
    const out = await syncAll(org.owner, { workspaceId: org.a });
    expect(out.counts.map((c) => [c!.inserted, c!.updated])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(await db.select().from(reviews).where(eq(reviews.orgId, org.orgId))).toHaveLength(5);
  });

  it("picks up a reply made in Google and an edited review; the replied filter flips", async () => {
    const unrepliedBefore = (await listAll(org.owner, { locationIds: [l1.id], replied: false }))
      .length;
    expect(unrepliedBefore).toBe(4);
    const [target] = await db
      .select()
      .from(reviews)
      .where(and(eq(reviews.locationId, l1.id), eq(reviews.starRating, 5)));
    mock.updateReview(target!.googleReviewName, { reply: "Posted in the Google UI" });
    const other = (
      await db
        .select()
        .from(reviews)
        .where(and(eq(reviews.locationId, l1.id), eq(reviews.starRating, 1)))
    )[0]!;
    mock.updateReview(other.googleReviewName, { comment: "edited text", starRating: "TWO" });
    const out = await syncAll(org.owner, { workspaceId: org.a, locationIds: [l1.id] });
    expect(out.counts[0]).toMatchObject({ fetched: 4, inserted: 0, updated: 2 });
    expect((await listAll(org.owner, { locationIds: [l1.id], replied: false })).length).toBe(3);
    const replied = await listAll(org.owner, { locationIds: [l1.id], replied: true });
    expect(replied.map((r) => r.reply?.comment)).toEqual(["Posted in the Google UI"]);
    const edited = (await run(org.owner, "reviews.get", { id: other.id })) as { review: Item };
    expect(edited.review).toMatchObject({ comment: "edited text", rating: 2 });
    // and a reply removed in Google goes away again
    mock.updateReview(target!.googleReviewName, { reply: null });
    await syncAll(org.owner, { workspaceId: org.a, locationIds: [l1.id] });
    expect((await listAll(org.owner, { locationIds: [l1.id], replied: true })).length).toBe(0);
  });

  it("an older copy never overwrites a newer row", async () => {
    const [row] = await db.select().from(reviews).where(eq(reviews.locationId, l2.id));
    const stale = {
      name: row!.googleReviewName,
      reviewId: "x",
      starRating: 1,
      comment: "stale",
      createTime: row!.createTime.toISOString(),
      updateTime: new Date(row!.updateTime.getTime() - 60_000).toISOString(),
    };
    const { upsertReviews } = await import("./reviews/upsert");
    const res = await db.transaction((tx) => upsertReviews(tx, l2, [stale]));
    expect(res).toEqual({ inserted: 0, updated: 0 });
    const [after] = await db.select().from(reviews).where(eq(reviews.id, row!.id));
    expect(after!.comment).toBe(row!.comment);
  });

  it("stores Google's reply moderation state from a recorded live response (REJECTED is surfaced)", async () => {
    const { readFileSync } = await import("node:fs");
    const { mapReview } = await import("./google/reviews");
    const { upsertReviews } = await import("./reviews/upsert");
    const body = JSON.parse(
      readFileSync(new URL("./google/fixtures/live/reviews-list.json", import.meta.url), "utf8"),
    ).body as { reviews: Parameters<typeof mapReview>[0][] };
    const live = await org.mkLoc(org.b, "Live Fixture Clinic");
    // Recorded names share a placeholder review id; give each a unique name under this location.
    const incoming = body.reviews.map((r, i) =>
      mapReview({ ...r, name: `${live.googleAccountName}/${live.googleLocationId}/reviews/R${i}` }),
    );
    await db.transaction((tx) => upsertReviews(tx, live, incoming));
    const items = await listAll(org.owner, { locationIds: [live.id] });
    expect(items).toHaveLength(12);
    const states = items.map((r) => r.reply?.state);
    expect(states.filter((s) => s === "APPROVED")).toHaveLength(11);
    const rejected = items.filter((r) => r.reply?.state === "REJECTED");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reply!.policyViolation).toBe("ACCOUNT_RESTRICTED_AND_EDIT_REJECTED");
    // a REJECTED reply is hidden from customers, so it counts as unreplied
    const unrepliedIds = (await listAll(org.owner, { locationIds: [live.id], replied: false })).map(
      (r) => r.id,
    );
    const repliedIds = (await listAll(org.owner, { locationIds: [live.id], replied: true })).map(
      (r) => r.id,
    );
    expect(unrepliedIds).toEqual([rejected[0]!.id]);
    expect(repliedIds).toHaveLength(11);
    expect(repliedIds).not.toContain(rejected[0]!.id);
    const bulk = (await run(org.owner, "reviews.list_unreplied", {
      includeSkipped: true,
      limit: 200,
    })) as { items: { id: string }[] };
    const bulkIds = bulk.items.map((i) => i.id);
    expect(bulkIds).toContain(rejected[0]!.id);
    expect(repliedIds.filter((id) => bulkIds.includes(id))).toEqual([]);
    // a state change alone (same update time) is still written
    const flipped = incoming.map((r) =>
      r.reviewReply ? { ...r, reviewReply: { ...r.reviewReply, reviewReplyState: "APPROVED" } } : r,
    );
    await db.transaction((tx) => upsertReviews(tx, live, flipped));
    const after = await listAll(org.owner, { locationIds: [live.id] });
    expect(after.filter((r) => r.reply?.state === "REJECTED")).toHaveLength(0);
    // keep later tests' per-workspace sync counts unchanged
    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, live.id));
  });

  it("follows every page (more than one Google page of reviews)", async () => {
    const big = await org.mkLoc(org.b, "Big Clinic");
    const m = new MockGoogleClient();
    for (let i = 0; i < 120; i++) {
      m.addReview(big.googleAccountName!, big.googleLocationId!, {
        createTime: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
      });
    }
    const out = (await run(org.owner, "reviews.sync", { workspaceId: org.b })) as {
      syncs: { syncId: string }[];
    };
    const counts = await processReviewSync(db, out.syncs[0]!.syncId, { client: m });
    expect(counts).toMatchObject({ fetched: 120, inserted: 120, truncated: false });
    expect(m.calls.filter((c) => c.method === "listReviews")).toHaveLength(3);
    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, big.id));
  });

  it("the sync also mirrors the location's Google posts, and a posts failure never fails the review sync", async () => {
    const l = await org.mkLoc(org.b, "Posts Clinic");
    const m = new MockGoogleClient();
    const parent = `${l.googleAccountName}/${l.googleLocationId}`;
    await m.createLocalPost(parent, { topicType: "STANDARD", summary: "made on Google" });
    const queue = async () =>
      ((await run(org.owner, "reviews.sync", { workspaceId: org.b })) as { syncs: { syncId: string; locationId: string }[] })
        .syncs.filter((x) => x.locationId === l.id)[0]!.syncId;
    expect(await processReviewSync(db, await queue(), { client: m })).not.toBeNull();
    const mirrored = await db.select().from(googlePosts).where(eq(googlePosts.locationId, l.id));
    expect(mirrored.map((x) => x.summary)).toEqual(["made on Google"]);

    const broken = Object.assign(Object.create(m), {
      listLocalPosts: async () => {
        throw new Error("google down");
      },
    }) as MockGoogleClient;
    expect(await processReviewSync(db, await queue(), { client: broken })).not.toBeNull();
    expect(await db.select().from(googlePosts).where(eq(googlePosts.locationId, l.id))).toHaveLength(1);
    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, l.id));
  });

  it("the sync also mirrors the location's Google photos (X3a), and a photos failure leaves the posts mirror and the review sync intact", async () => {
    const l = await org.mkLoc(org.b, "Photos Clinic");
    const m = new MockGoogleClient();
    const parent = `${l.googleAccountName}/${l.googleLocationId}`;
    await m.createLocalPost(parent, { topicType: "STANDARD", summary: "a post" });
    await m.createMedia(parent, { mediaFormat: "PHOTO", locationAssociation: { category: "EXTERIOR" }, sourceUrl: "https://src.test/a.jpg", description: "Front" });
    const queue = async () =>
      ((await run(org.owner, "reviews.sync", { workspaceId: org.b })) as { syncs: { syncId: string; locationId: string }[] })
        .syncs.filter((x) => x.locationId === l.id)[0]!.syncId;
    expect(await processReviewSync(db, await queue(), { client: m })).not.toBeNull();
    const photos = await db.select().from(googleMedia).where(eq(googleMedia.locationId, l.id));
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({ category: "EXTERIOR", description: "Front", googleUrl: expect.stringContaining("https://") });

    const broken = Object.assign(Object.create(m), {
      listMedia: async () => {
        throw new Error("google down");
      },
    }) as MockGoogleClient;
    expect(await processReviewSync(db, await queue(), { client: broken })).not.toBeNull();
    expect(await db.select().from(googleMedia).where(eq(googleMedia.locationId, l.id))).toHaveLength(1);
    expect(await db.select().from(googlePosts).where(eq(googlePosts.locationId, l.id))).toHaveLength(1);
    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, l.id));
  });

  it("a location deactivated after the request: the job fetches nothing and the sync fails as location_inactive", async () => {
    const loc = await org.mkLoc(org.b, "Soon closed");
    const m = new MockGoogleClient();
    const out = (await run(org.owner, "reviews.sync", { workspaceId: org.b })) as {
      syncs: { syncId: string; locationId: string }[];
    };
    const mine = out.syncs.find((s) => s.locationId === loc.id)!;
    for (const s of out.syncs) {
      if (s !== mine) await processReviewSync(db, s.syncId, { client: m });
    }
    await run(org.owner, "locations.setStatus", { locationIds: [loc.id], status: "inactive" });
    m.calls.length = 0;
    expect(await processReviewSync(db, mine.syncId, { client: m })).toBeNull();
    expect(m.callCount).toBe(0);
    const [row] = await db.select().from(reviewSyncs).where(eq(reviewSyncs.id, mine.syncId));
    expect(row).toMatchObject({ status: "failed", error: "location_inactive" });
    expect(await db.select().from(reviews).where(eq(reviews.locationId, loc.id))).toHaveLength(0);
  });

  it("a Google failure changes nothing, leaves the sync pending, and is failed on the final attempt", async () => {
    const out = (await run(org.owner, "reviews.sync", {
      workspaceId: org.a,
      locationIds: [l2.id],
    })) as {
      syncs: { syncId: string }[];
    };
    const id = out.syncs[0]!.syncId;
    const m = new MockGoogleClient();
    m.failNext(2, () => new Error("boom"));
    await expect(processReviewSync(db, id, { client: m })).rejects.toThrow("boom");
    expect((await db.select().from(reviewSyncs).where(eq(reviewSyncs.id, id)))[0]!.status).toBe(
      "pending",
    );
    await expect(processReviewSync(db, id, { client: m, isFinalAttempt: true })).rejects.toThrow(
      "boom",
    );
    expect((await db.select().from(reviewSyncs).where(eq(reviewSyncs.id, id)))[0]).toMatchObject({
      status: "failed",
      error: "google_fetch_failed",
    });
    await failReviewSync(db, id, "other"); // settled: no-op
    expect((await db.select().from(reviewSyncs).where(eq(reviewSyncs.id, id)))[0]!.error).toBe(
      "google_fetch_failed",
    );
  });

  it("audit rows for sync carry counts only, never review text", async () => {
    const rows = await db.select().from(auditLog).where(eq(auditLog.orgId, org.orgId));
    const syncRows = rows.filter((r) => r.action.startsWith("review_sync."));
    expect(
      syncRows.some((r) => r.action === "review_sync.completed" && r.surface === "worker"),
    ).toBe(true);
    expect(syncRows.some((r) => r.action === "review_sync.skipped")).toBe(true);
    expect(syncRows.some((r) => r.action === "review_sync.failed")).toBe(true);
    const blob = JSON.stringify(rows);
    for (const needle of [
      "back pain",
      "diabetes",
      "Dr Smith",
      "Pat Q",
      "Posted in the Google UI",
      "edited text",
    ]) {
      expect(blob).not.toContain(needle);
    }
    const done = syncRows.find((r) => r.action === "review_sync.completed")!;
    expect(Object.keys(done.after as object).sort()).toEqual(
      ["fetched", "inserted", "locationId", "requestedBy", "truncated", "updated"].sort(),
    );
    expect((await verifyAuditChain(db, org.orgId)).ok).toBe(true);
  });
});

describe("reviews.list filters and paging", () => {
  let org: Org;
  let la: Awaited<ReturnType<Org["mkLoc"]>>;
  let lb: Awaited<ReturnType<Org["mkLoc"]>>;
  let lc: Awaited<ReturnType<Org["mkLoc"]>>; // workspace B
  let off: Awaited<ReturnType<Org["mkLoc"]>>;
  let groupId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    org = await makeOrg();
    la = await org.mkLoc(org.a, "Loc A");
    lb = await org.mkLoc(org.a, "Loc B");
    lc = await org.mkLoc(org.b, "Loc C");
    off = await org.mkLoc(org.a, "Loc Off", "inactive");
    const [g] = await db
      .insert(locationGroups)
      .values({ orgId: org.orgId, workspaceId: org.a, name: "North" })
      .returning();
    groupId = g!.id;
    await db.insert(locationGroupMembers).values({ groupId, locationId: lb.id, orgId: org.orgId });
    ids.a1 = (await mkReview(la, { rating: 1, createTime: "2026-09-01T00:00:00Z" })).id;
    ids.a5 = (await mkReview(la, { rating: 5, reply: "r", createTime: "2026-09-02T00:00:00Z" })).id;
    ids.aNull = (
      await mkReview(la, { rating: null, comment: null, createTime: "2026-09-03T00:00:00Z" })
    ).id;
    ids.b3 = (await mkReview(lb, { rating: 3, createTime: "2026-09-04T00:00:00Z" })).id;
    ids.b2r = (
      await mkReview(lb, { rating: 2, reply: "r", createTime: "2026-09-05T00:00:00Z" })
    ).id;
    ids.c4 = (await mkReview(lc, { rating: 4, createTime: "2026-09-06T00:00:00Z" })).id;
    ids.off = (await mkReview(off, { rating: 1, createTime: "2026-09-07T00:00:00Z" })).id;
  });

  const idsOf = async (input: Record<string, unknown>, actor = org.owner) =>
    (await listAll(actor, input)).map((i) => i.id);
  const label = (list: string[]) =>
    list.map((id) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? "tied");

  it("orders newest first and excludes inactive locations", async () => {
    expect(label(await idsOf({}))).toEqual(["c4", "b2r", "b3", "aNull", "a5", "a1"]);
  });

  it("each filter", async () => {
    expect(label(await idsOf({ workspaceId: org.b }))).toEqual(["c4"]);
    expect(label(await idsOf({ locationIds: [la.id] }))).toEqual(["aNull", "a5", "a1"]);
    expect(label(await idsOf({ groupId }))).toEqual(["b2r", "b3"]);
    expect(label(await idsOf({ ratings: [1, 2] }))).toEqual(["b2r", "a1"]);
    expect(label(await idsOf({ replied: true }))).toEqual(["b2r", "a5"]);
    expect(label(await idsOf({ replied: false }))).toEqual(["c4", "b3", "aNull", "a1"]);
    expect(label(await idsOf({ ratings: [1, 2, 3, 4, 5] }))).not.toContain("aNull"); // star-less never matches a rating
  });

  it("date range: from inclusive, to exclusive (UTC)", async () => {
    expect(label(await idsOf({ from: "2026-09-02T00:00:00Z" }))).toEqual([
      "c4",
      "b2r",
      "b3",
      "aNull",
      "a5",
    ]);
    expect(label(await idsOf({ to: "2026-09-03T00:00:00Z" }))).toEqual(["a5", "a1"]);
    expect(
      label(await idsOf({ from: "2026-09-02T00:00:00Z", to: "2026-09-04T00:00:00Z" })),
    ).toEqual(["aNull", "a5"]);
    // an offset is honoured: 02:00+02:00 is 00:00Z
    expect(
      label(await idsOf({ from: "2026-09-04T02:00:00+02:00", to: "2026-09-05T02:00:00+02:00" })),
    ).toEqual(["b3"]);
  });

  it("combinations", async () => {
    expect(
      label(await idsOf({ locationIds: [la.id, lb.id], ratings: [1, 3], replied: false })),
    ).toEqual(["b3", "a1"]);
    expect(label(await idsOf({ groupId, replied: true, from: "2026-09-05T00:00:00Z" }))).toEqual([
      "b2r",
    ]);
    expect(await idsOf({ workspaceId: org.b, ratings: [1] })).toEqual([]);
  });

  it("keyset cursor: no gaps or duplicates, including identical create times", async () => {
    const tied = await org.mkLoc(org.a, "Tied");
    for (let i = 0; i < 7; i++) await mkReview(tied, { createTime: "2026-10-01T00:00:00Z" });
    const all = await listAll(org.owner, { locationIds: [tied.id] }, 100);
    expect(all).toHaveLength(7);
    for (const size of [1, 2, 3, 7]) {
      const paged = await listAll(org.owner, { locationIds: [tied.id] }, size);
      expect(paged.map((i) => i.id)).toEqual(all.map((i) => i.id));
    }
    const whole = await listAll(org.owner, {}, 2);
    expect(new Set(whole.map((i) => i.id)).size).toBe(whole.length);
    expect(whole.map((i) => i.id)).toEqual(await idsOf({}));
  });

  it("validates input", async () => {
    expect(await codeOf(run(org.owner, "reviews.list", { limit: 101 }))).toBe("INVALID_INPUT");
    expect(await codeOf(run(org.owner, "reviews.list", { ratings: [6] }))).toBe("INVALID_INPUT");
    expect(await codeOf(run(org.owner, "reviews.list", { from: "yesterday" }))).toBe(
      "INVALID_INPUT",
    );
    expect(await codeOf(run(org.owner, "reviews.list", { cursor: "garbage" }))).toBe(
      "INVALID_INPUT",
    );
  });

  it("client_viewer and client_approver see only their workspace; others are FORBIDDEN or NOT_FOUND", async () => {
    for (const actor of [org.viewer, org.approver]) {
      expect(label(await idsOf({}, actor))).toEqual([
        ...Array(7).fill("tied"), // the 7 reviews added by the paging test, also workspace A
        "b2r",
        "b3",
        "aNull",
        "a5",
        "a1",
      ]);
      expect(await codeOf(run(actor, "reviews.list", { workspaceId: org.b }))).toBe("FORBIDDEN");
      expect(label(await idsOf({ locationIds: [lc.id] }, actor))).toEqual([]);
      expect(await codeOf(run(actor, "reviews.get", { id: ids.c4! }))).toBe("NOT_FOUND");
      expect(
        ((await run(actor, "reviews.get", { id: ids.a1! })) as { review: Item }).review.id,
      ).toBe(ids.a1);
    }
  });

  it("reviews.get hides inactive-location reviews and other orgs' reviews", async () => {
    expect(await codeOf(run(org.owner, "reviews.get", { id: ids.off! }))).toBe("NOT_FOUND");
    const other = await makeOrg();
    expect(await codeOf(run(other.owner, "reviews.get", { id: ids.a1! }))).toBe("NOT_FOUND");
    expect(await idsOf({}, other.owner)).toEqual([]);
    const got = (await run(org.owner, "reviews.get", { id: ids.a5! })) as { review: Item };
    expect(got.review).toMatchObject({
      rating: 5,
      location: { id: la.id, name: "Loc A" },
      reply: { comment: "r" },
    });
  });

  it("reviews.syncStatus is scoped to the caller's workspaces", async () => {
    const [s1] = await db
      .insert(reviewSyncs)
      .values({ orgId: org.orgId, locationId: la.id })
      .returning();
    const [s2] = await db
      .insert(reviewSyncs)
      .values({ orgId: org.orgId, locationId: lc.id })
      .returning();
    const seen = (await run(org.viewer, "reviews.syncStatus", { syncIds: [s1!.id, s2!.id] })) as {
      syncs: { id: string }[];
    };
    expect(seen.syncs.map((s) => s.id)).toEqual([s1!.id]);
    const all = (await run(org.owner, "reviews.syncStatus", { syncIds: [s1!.id, s2!.id] })) as {
      syncs: unknown[];
    };
    expect(all.syncs).toHaveLength(2);
  });
});

describe("reviews.list_unreplied (the bulk MCP tool)", () => {
  let org: Org;
  let other: Org;
  let la: Awaited<ReturnType<Org["mkLoc"]>>;
  let lc: Awaited<ReturnType<Org["mkLoc"]>>;
  let off: Awaited<ReturnType<Org["mkLoc"]>>;

  beforeAll(async () => {
    org = await makeOrg();
    other = await makeOrg();
    la = await org.mkLoc(org.a, "Loc A");
    lc = await org.mkLoc(org.b, "Loc C");
    off = await org.mkLoc(org.a, "Loc Off", "inactive");
    const otherLoc = await other.mkLoc(other.a, "Foreign");
    for (let i = 0; i < 5; i++) {
      await mkReview(la, { rating: i === 0 ? 5 : 2, createTime: `2026-09-0${i + 1}T00:00:00Z` });
    }
    await mkReview(la, { reply: "answered", createTime: "2026-09-09T00:00:00Z" });
    await mkReview(lc, { rating: 1, createTime: "2026-09-10T00:00:00Z" });
    await mkReview(off, { createTime: "2026-09-11T00:00:00Z" });
    await mkReview(otherLoc, { createTime: "2026-09-12T00:00:00Z" });
  });

  const unreplied = (actor: Actor, input: Record<string, unknown> = {}) =>
    run(actor, "reviews.list_unreplied", input) as Promise<UnrepliedOut>;

  it("returns only unreplied reviews at active locations in the caller's org, newest first", async () => {
    const r = await unreplied(org.owner);
    expect(r.totalReturned).toBe(6);
    expect(r.items.map((i) => i.location.name)).toEqual([
      "Loc C",
      "Loc A",
      "Loc A",
      "Loc A",
      "Loc A",
      "Loc A",
    ]);
    expect(
      r.items.every((i) => i.reply === null && i.replyAllowed === true && i.skipReason === null),
    ).toBe(true);
    expect(r.nextCursor).toBeNull();
    const times = r.items.map((i) => i.createTime);
    expect(times).toEqual([...times].sort().reverse());
  });

  it("respects limit and cursor (no gaps, no duplicates) and the 200 cap", async () => {
    const full = (await unreplied(org.owner)).items.map((i) => i.id);
    for (const limit of [1, 2, 4]) {
      const got: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const r = await unreplied(org.owner, { limit, cursor });
        expect(r.items.length).toBeLessThanOrEqual(limit);
        expect(r.totalReturned).toBe(r.items.length);
        got.push(...r.items.map((i) => i.id));
        cursor = r.nextCursor ?? undefined;
        pages++;
      } while (cursor);
      expect(got).toEqual(full);
      expect(pages).toBe(Math.ceil(full.length / limit));
    }
    expect(await codeOf(unreplied(org.owner, { limit: 201 }))).toBe("INVALID_INPUT");
    expect((await unreplied(org.owner, { limit: 200 })).items).toHaveLength(6);
  });

  it("is scoped: client_viewer in workspace A sees only A; viewers have review:read", async () => {
    const r = await unreplied(org.viewer);
    expect(r.items.map((i) => i.location.name)).toEqual([
      "Loc A",
      "Loc A",
      "Loc A",
      "Loc A",
      "Loc A",
    ]);
    expect((await unreplied(other.owner)).items.map((i) => i.location.name)).toEqual(["Foreign"]);
  });

  it("includeSkipped: skipped reviews are hidden by default, shown with replyAllowed=false when asked, and paging stays exact", async () => {
    policy.skipFiveStar = true;
    try {
      const hidden = await unreplied(org.owner);
      expect(hidden.items.every((i) => i.rating !== 5)).toBe(true);
      expect(hidden.totalReturned).toBe(5);
      const shown = await unreplied(org.owner, { includeSkipped: true });
      expect(shown.totalReturned).toBe(6);
      const skipped = shown.items.filter((i) => !i.replyAllowed);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatchObject({ rating: 5, skipReason: "test_skip" });
      // limit counts returned items, not scanned rows
      const got: string[] = [];
      let cursor: string | undefined;
      do {
        const r = await unreplied(org.owner, { limit: 2, cursor });
        got.push(...r.items.map((i) => i.id));
        cursor = r.nextCursor ?? undefined;
      } while (cursor);
      expect(got).toEqual(hidden.items.map((i) => i.id));
    } finally {
      policy.skipFiveStar = false;
    }
  });
});

describe("replyPolicy", () => {
  it("allows every review with default settings (general baseline)", async () => {
    const real =
      await vi.importActual<typeof import("./reviews/reply-policy")>("./reviews/reply-policy");
    for (const starRating of [null, 1, 3, 4, 5]) {
      expect(real.replyPolicy({ starRating, comment: "x" }, { id: "w", name: "General" })).toEqual({
        replyAllowed: true,
        skipReason: null,
      });
    }
  });

  it("G4: skipPositiveReviews turns off replies to 4-5 star reviews only", async () => {
    const real =
      await vi.importActual<typeof import("./reviews/reply-policy")>("./reviews/reply-policy");
    const ws = { skipPositiveReviews: true };
    for (const starRating of [4, 5]) {
      expect(real.replyPolicy({ starRating, comment: "x" }, ws)).toEqual({
        replyAllowed: false,
        skipReason: "Healthcare profile: replies to positive reviews are off",
      });
    }
    for (const starRating of [null, 1, 2, 3]) {
      expect(real.replyPolicy({ starRating, comment: "x" }, ws).replyAllowed).toBe(true);
    }
  });
});
