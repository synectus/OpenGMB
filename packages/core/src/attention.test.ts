import { afterAll, describe, expect, it, vi } from "vitest";
import {
  apiTokens,
  createDb,
  mcpProposals,
  profileChanges,
  reviewReplies,
  memberships,
  reviews,
  workspaceReplySettings,
  workspaces,
} from "@opengmb/db";
import { and, eq, ne } from "drizzle-orm";
import { byUrgency, HOME_OWNER_MAX_LOCATIONS, type AttentionKind } from "./attention";
import { MockGoogleClient } from "./google/mock-client";
import { replyPolicy } from "./reviews/reply-policy";
import { TO_ANSWER_STAGES, replyStageOf, type OpenReplyStatus } from "./reviews/reply-stage";
import { codeOf, makeKit, uniq, type Loc, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
const { run } = kit;

afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

type Split = { reply: number; post: number; changeset: number; total: number };
type Counts = {
  approvals: Split;
  waitingToPublish: number;
  reviews: { negative: number; other: number; total: number };
  changes: number;
  proposals: number;
  failed: Split;
  total: number;
  negativeMaxStars: number;
};
const empty = { fields: {}, attributes: {} };
let seq = 0;

async function review(loc: Loc, rating: number | null, extra: Partial<typeof reviews.$inferInsert> = {}) {
  const at = new Date(Date.UTC(2026, 9, 1, 9, seq % 60));
  const [r] = await db
    .insert(reviews)
    .values({
      orgId: loc.row.orgId,
      workspaceId: loc.row.workspaceId,
      locationId: loc.row.id,
      googleReviewName: `${loc.parent}/reviews/${uniq()}-${seq++}`,
      starRating: rating,
      comment: "Waited far too long for my appointment.",
      createTime: at,
      updateTime: at,
      ...extra,
    })
    .returning();
  return r!;
}

async function reply(
  org: Org,
  r: { id: string; orgId: string; workspaceId: string },
  status: "draft" | "pending_approval" | "approved" | "failed" | "blocked",
) {
  const [row] = await db
    .insert(reviewReplies)
    .values({
      orgId: r.orgId,
      workspaceId: r.workspaceId,
      reviewId: r.id,
      revision: 1,
      body: "Thank you for telling us.",
      status,
      createdBy: org.ownerId,
      createdSurface: "ui",
      submittedAt: status === "draft" ? null : new Date(),
      failureReason: status === "failed" ? "google_writes_disabled" : null,
    })
    .returning();
  return row!;
}

const counts = (org: Org, input: object = {}, actor = org.owner) =>
  run<Counts>(actor, "attention.counts", input);

describe("attention.counts", () => {
  it("puts each waiting thing in exactly one bucket, and the total is their sum", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    await review(loc, 2); // negative
    await review(loc, 5); // other
    await review(loc, null); // other (unrated)
    await review(loc, 4, { replyComment: "Thanks!" }); // answered: no bucket
    await reply(org, await review(loc, 1), "pending_approval"); // approvals only
    await reply(org, await review(loc, 3), "failed"); // failed only
    await reply(org, await review(loc, 2), "draft"); // still a negative review
    const c = await counts(org);
    expect(c.reviews).toEqual({ negative: 2, other: 2, total: 4 });
    expect(c.approvals).toEqual({ reply: 1, post: 0, changeset: 0, postedit: 0, total: 1 });
    expect(c.failed).toEqual({ reply: 1, post: 0, changeset: 0, total: 1 });
    expect(c.total).toBe(c.approvals.total + c.reviews.total + c.changes + c.proposals + c.failed.total);
    expect(c.total).toBe(6);
    expect(c.negativeMaxStars).toBe(3);
  });

  it("follows the reply policy (canary: replyPolicy itself skips 4 and 5 stars)", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.b);
    await db.insert(workspaceReplySettings).values({ workspaceId: org.b, orgId: org.orgId, skipPositiveReviews: true });
    for (const rating of [1, 2, 3, 4, 5]) await review(loc, rating);
    const allowed = [1, 2, 3, 4, 5].filter(
      (s) => replyPolicy({ starRating: s, comment: null }, { skipPositiveReviews: true }).replyAllowed,
    );
    expect(allowed).toEqual([1, 2, 3]);
    const c = await counts(org, { workspaceId: org.b });
    expect(c.reviews).toEqual({ negative: 3, other: 0, total: allowed.length });
  });

  it("agrees with approvals.counts and with the Alerts page's open count", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    await reply(org, await review(loc, 2), "pending_approval");
    await db.insert(profileChanges).values([
      { orgId: org.orgId, locationId: loc.row.id, source: "nightly", fieldPaths: ["websiteUri"], before: empty, after: empty },
      { orgId: org.orgId, locationId: loc.row.id, source: "nightly", fieldPaths: ["title"], before: empty, after: empty, status: "accepted" },
    ]);
    const c = await counts(org);
    expect(c.approvals).toEqual(await run(org.owner, "approvals.counts"));
    const open = await run<{ total: number }>(org.owner, "profile.changes.list", { status: "open", limit: 1 });
    expect(c.changes).toBe(open.total);
    expect(c.changes).toBe(1);
  });

  it("every review state lands in the bucket the shared reply stage names (H4: the counts query is pinned to replyStageOf)", async () => {
    const org = await kit.makeOrg();
    const locA = await org.mkLoc(org.a);
    const locB = await org.mkLoc(org.b);
    await db.insert(workspaceReplySettings).values({ workspaceId: org.b, orgId: org.orgId, skipPositiveReviews: true });
    const visible = [
      { replyComment: null, replyState: null },
      { replyComment: "Thanks!", replyState: null },
      { replyComment: "Thanks!", replyState: "REJECTED" },
    ];
    const open: (OpenReplyStatus | null)[] = [null, "draft", "pending_approval", "approved", "blocked", "failed"];
    const want = { [org.a]: { negative: 0, other: 0, waiting: 0 }, [org.b]: { negative: 0, other: 0, waiting: 0 } };
    let made = 0;
    for (const [ws, loc, skip] of [[org.a, locA, false], [org.b, locB, true]] as const) {
      for (const v of visible) {
        for (const o of open) {
          for (const rating of [null, 1, 3, 4, 5]) {
            const r = await review(loc, rating, v);
            if (o) await reply(org, r, o);
            made++;
            const stage = replyStageOf({ ...v, starRating: rating, openStatus: o, skipPositiveReviews: skip });
            if ((TO_ANSWER_STAGES as readonly string[]).includes(stage)) want[ws]![rating !== null && rating <= 3 ? "negative" : "other"]++;
            if (stage === "waiting_publish") want[ws]!.waiting++;
          }
        }
      }
    }
    expect(made).toBe(180); // the denominator: 3 visible states x 6 open states x 5 ratings x 2 workspaces
    expect(want[org.a]!.negative + want[org.a]!.other).toBeGreaterThan(0);
    expect(want[org.a]!.waiting).toBeGreaterThan(0);
    for (const ws of [org.a, org.b]) {
      const c = await counts(org, { workspaceId: ws });
      expect({ negative: c.reviews.negative, other: c.reviews.other, waiting: c.waitingToPublish }).toEqual(want[ws]);
    }
    const all = await counts(org);
    expect(all.reviews.total).toBe(want[org.a]!.negative + want[org.a]!.other + want[org.b]!.negative + want[org.b]!.other);
    expect(all.waitingToPublish).toBe(want[org.a]!.waiting + want[org.b]!.waiting);
  });

  it("narrows to one workspace, and a client approver sees only theirs", async () => {
    const org = await kit.makeOrg();
    await review(await org.mkLoc(org.a), 2);
    await review(await org.mkLoc(org.b), 2);
    expect((await counts(org)).reviews.negative).toBe(2);
    expect((await counts(org, { workspaceId: org.a })).reviews.negative).toBe(1);
    expect((await counts(org, {}, org.approverA)).reviews.negative).toBe(1);
    expect(await codeOf(counts(org, { workspaceId: org.b }, org.approverA))).toBe("FORBIDDEN");
  });

  it("counts only the caller's own pending, unexpired proposals (same rows as mcp.proposals.list)", async () => {
    const org = await kit.makeOrg();
    const token = async (userId: string) =>
      (await db.insert(apiTokens).values({ orgId: org.orgId, userId, name: "t", tokenHash: uniq() }).returning())[0]!;
    const mine = await token(org.ownerId);
    const theirs = await token(org.manager.userId);
    const p = (tokenId: string, userId: string, minutes: number, status: "pending" | "applied" = "pending") => ({
      orgId: org.orgId,
      tokenId,
      userId,
      action: "posts.createDraft",
      input: {},
      inputHash: uniq(),
      preview: { summary: "Create a draft post. It needs approval." },
      status,
      expiresAt: new Date(Date.now() + minutes * 60_000),
    });
    await db.insert(mcpProposals).values([
      p(mine.id, org.ownerId, 10),
      p(mine.id, org.ownerId, -1),
      p(mine.id, org.ownerId, 10, "applied"),
      p(theirs.id, org.manager.userId, 10),
    ]);
    const c = await counts(org);
    expect(c.proposals).toBe(1);
    const listed = await run<{ proposals: unknown[] }>(org.owner, "mcp.proposals.list", { status: "pending" });
    expect(listed.proposals).toHaveLength(c.proposals);
  });
});
type Item = {
  kind: string;
  subject: string;
  id: string;
  reviewId: string | null;
  title: string;
  code: string | null;
  replyStatus: string | null;
  locationNames: string[];
};
type Queue = {
  activeLocations: number;
  setup: {
    workspaces: number;
    googleConnections: number;
    locations: number;
    activeLocations: number;
    hasReviews: boolean;
    hasPerformance: boolean;
  };
  relink: { workspaceId: string; workspaceName: string; locations: number }[];
  counts: Counts;
  items: Item[];
  truncated: boolean;
  clients: { name: string; activeLocations: number; attention: number; ratingTrend: (number | null)[] }[];
  locations: { title: string; reviews: { total: number; unreplied: number }; lastPostAt: string | null; performance: { hasData: boolean } }[];
  autoApprove: { workspaceName: string; minStars: number }[];
};
const queue = (org: Org, input: object = {}) => run<Queue>(org.owner, "attention.queue", input);

describe("byUrgency", () => {
  it("orders by tier, then newest first, then id", () => {
    const i = (kind: AttentionKind, at: string, id: string) => ({ kind, at, id });
    const list = [
      i("review", "2026-10-19T09:00:00.000Z", "a"),
      i("failed", "2026-10-01T00:00:00.000Z", "b"),
      i("approval", "2026-10-18T00:00:00.000Z", "c"),
      i("negative_review", "2026-10-17T00:00:00.000Z", "d"),
      i("approval", "2026-10-19T00:00:00.000Z", "e"),
      i("change", "2026-10-19T00:00:00.000Z", "f"),
      i("proposal", "2026-10-19T00:00:00.000Z", "g"),
    ];
    expect(list.sort(byUrgency).map((x) => x.id)).toEqual(["b", "d", "e", "c", "g", "f", "a"]);
  });
});

describe("attention.queue", () => {
  it("merges every bucket most urgent first, with the same counts as attention.counts", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    await review(loc, 5);
    const neg = await review(loc, 1);
    await reply(org, neg, "draft");
    await reply(org, await review(loc, 2), "failed");
    await db.insert(profileChanges).values({
      orgId: org.orgId, locationId: loc.row.id, source: "nightly", fieldPaths: ["regularHours"], before: empty, after: empty,
    });
    const q = await queue(org);
    expect(q.items.map((i) => i.kind)).toEqual(["failed", "negative_review", "change", "review"]);
    expect(q.items[0]).toMatchObject({ subject: "reply", title: "Reply not published", code: "google_writes_disabled" });
    expect(q.items[1]).toMatchObject({ title: "1★ review, no reply", replyStatus: "draft", reviewId: neg.id, locationNames: [loc.row.name] });
    expect(q.items[2]!.title).toBe("regularHours changed outside OpenGMB");
    expect(q.counts).toEqual(await counts(org));
    expect(q.truncated).toBe(false);
  });

  it("cuts at limit and says so", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    for (const r of [1, 2, 5]) await review(loc, r);
    const q = await queue(org, { limit: 2 });
    expect(q.items.map((i) => i.kind)).toEqual(["negative_review", "negative_review"]);
    expect(q.truncated).toBe(true);
    expect(q.counts.total).toBe(3);
  });

  it(`one card per active location, at most ${HOME_OWNER_MAX_LOCATIONS}`, async () => {
    expect(HOME_OWNER_MAX_LOCATIONS).toBe(3);
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    await review(loc, 4);
    const q = await queue(org);
    expect(q.activeLocations).toBe(1);
    expect(q.locations).toHaveLength(1);
    expect(q.locations[0]).toMatchObject({
      title: loc.row.name,
      reviews: { total: 1, unreplied: 1 },
      lastPostAt: null,
      performance: { hasData: false },
    });
  });

  it("clients ranked by attention; setup stays org-wide while activeLocations follows workspaceId", async () => {
    const org = await kit.makeOrg();
    const a1 = await org.mkLoc(org.a);
    await org.mkLoc(org.a);
    await org.mkLoc(org.a);
    const b1 = await org.mkLoc(org.b);
    await review(a1, 2);
    await review(b1, 1);
    await review(b1, 2);
    const q = await queue(org);
    expect(q.activeLocations).toBe(4);
    expect(q.locations).toHaveLength(HOME_OWNER_MAX_LOCATIONS);
    expect(q.clients.map((c) => [c.name, c.activeLocations, c.attention])).toEqual([
      ["B", 1, 2],
      ["A", 3, 1],
    ]);
    expect(q.clients[0]!.ratingTrend).toHaveLength(6);
    const b = await queue(org, { workspaceId: org.b });
    expect(b.activeLocations).toBe(1);
    expect(b.setup).toMatchObject({ workspaces: 2, activeLocations: 4 });
    expect(b.clients.map((c) => c.name)).toEqual(["B"]);
  });

  it("reports setup facts, lost Google connections and auto-approve rules", async () => {
    const org = await kit.makeOrg();
    let q = await queue(org);
    expect(q.setup).toEqual({
      workspaces: 2, googleConnections: 1, locations: 0, activeLocations: 0, hasReviews: false, hasPerformance: false,
      healthReportSeen: false, setupDismissed: false, teamInvited: true, timeZoneSet: false,
    });
    await org.mkLoc(org.a, { connectionId: null });
    await db.insert(workspaceReplySettings).values({ workspaceId: org.a, orgId: org.orgId, autoApproveMinStars: 5 });
    q = await queue(org);
    expect(q.relink).toEqual([{ workspaceId: org.a, workspaceName: "A", locations: 1 }]);
    expect(q.autoApprove).toEqual([{ workspaceName: "A", minStars: 5 }]);
  });

  it("first-run facts (U10): team, time zone, health report seen, dismissed; each is real data", async () => {
    const org = await kit.makeOrg();
    // Alone in the organization: nobody invited yet.
    await db.delete(memberships).where(and(eq(memberships.orgId, org.orgId), ne(memberships.userId, org.ownerId)));
    let q = await queue(org);
    expect(q.setup).toMatchObject({ teamInvited: false, timeZoneSet: false, healthReportSeen: false, setupDismissed: false });

    // A pending invitation turns teamInvited on in the hosted edition: see attention.private.test.ts.
    await db.update(workspaces).set({ timeZone: "America/Chicago", timeZoneSource: "manual" }).where(eq(workspaces.id, org.a));
    q = await queue(org);
    expect(q.setup).toMatchObject({ teamInvited: false, timeZoneSet: true });

    const r = await run<{ healthReportSeen: boolean; dismissed: boolean }>(org.owner, "onboarding.update", { healthReportSeen: true });
    expect(r).toEqual({ healthReportSeen: true, dismissed: false });
    await run(org.owner, "onboarding.update", { dismissed: true });
    q = await queue(org);
    expect(q.setup).toMatchObject({ healthReportSeen: true, setupDismissed: true });
    // Seen stays on after a second call, and dismissal can be undone.
    await run(org.owner, "onboarding.update", { dismissed: false });
    q = await queue(org);
    expect(q.setup).toMatchObject({ healthReportSeen: true, setupDismissed: false });
    expect(await kit.auditRows(org.orgId, "onboarding.update")).toHaveLength(3);
  });

  it("only an owner or admin dismisses the checklist; any signed-in member can mark the report seen", async () => {
    const org = await kit.makeOrg();
    expect(await codeOf(run(org.manager, "onboarding.update", { dismissed: true }))).toBe("FORBIDDEN");
    await run(org.manager, "onboarding.update", { healthReportSeen: true });
  });
});
