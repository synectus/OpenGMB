import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  createDb,
  locationGroupMembers,
  locationGroups,
  locations,
  postEdits,
  profileChangeSets,
  reviewReplies,
  reviews,
  posts,
  users,
} from "@opengmb/db";
import type { Actor } from "./actor";
import { guardrailSummary, changeSetTitle, postTitle, replyTitle } from "./approval-queue";
import { setEmailSender } from "./email";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { ThrottledGoogleClient } from "./google/throttled-client";
import { POST_EDIT_QUEUE } from "./posts/edit";
import { POST_SEND_QUEUE, processPostSend } from "./posts/jobs";
import type { GuardrailResult } from "./guardrails";
import { ROLE_PERMISSIONS, roleHasPermission } from "./permissions";
import { codeOf, makeKit, uniq, type Loc } from "./testkit";

// The shared test database is also used by every other suite, often at the same time.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const { run } = kit;

const tok = () => Math.random().toString(36).slice(2, 10).replace(/\d/g, "q");
let seq = 0;

type Item = {
  type: "reply" | "post" | "changeset" | "postedit";
  postId: string | null;
  id: string;
  workspaceId: string;
  workspaceName: string;
  locationNames: string[];
  submittedAt: string | null;
  title: string;
  text: string;
  reviewId: string | null;
  review: { rating: number | null; comment: string | null; reviewerDisplayName: string | null } | null;
  topicType: string | null;
  guardrail: { blocked: boolean; warnings: number; warningsAcknowledged: boolean };
  provenance: { createdSurface: string; createdByName: string | null };
  can: { approve: boolean; reject: boolean };
};
type Counts = { reply: number; post: number; changeset: number; postedit: number; total: number };
type Queue = { items: Item[]; counts: Counts; truncated: boolean };

const keyOf = (i: { type: string; id: string }) => `${i.type}:${i.id}`;
const COMMENT = "Waited far too long for my appointment.";

async function mkReview(loc: Loc, rating: number) {
  const now = new Date();
  const [r] = await db
    .insert(reviews)
    .values({
      orgId: loc.row.orgId,
      workspaceId: loc.row.workspaceId,
      locationId: loc.row.id,
      googleReviewName: `${loc.row.googleAccountName}/${loc.row.googleLocationId}/reviews/${uniq()}-${seq++}`,
      reviewerDisplayName: "Pat Reviewer",
      starRating: rating,
      comment: COMMENT,
      createTime: now,
      updateTime: now,
    })
    .returning();
  return r!;
}

async function pendingReply(actor: Actor, loc: Loc, rating = 2) {
  const review = await mkReview(loc, rating);
  const { reply } = await run<{ reply: { id: string } }>(actor, "reviewReplies.createDraft", {
    reviewId: review.id,
    body: `Thank you for telling us. We will look into it ${tok()}.`,
  });
  const sub = await run<{ outcome: string }>(actor, "reviewReplies.submit", { id: reply.id });
  expect(sub.outcome).toBe("pending_approval");
  return reply.id;
}

async function pendingPost(actor: Actor, workspaceId: string, loc: Loc) {
  const { post } = await run<{ post: { id: string } }>(actor, "posts.createDraft", {
    workspaceId,
    locationIds: [loc.row.id],
    topicType: "STANDARD",
    summary: `Book online this week ${tok()}.`,
  });
  const sub = await run<{ outcome: string }>(actor, "posts.submit", {
    id: post.id,
    acknowledgeWarnings: true,
  });
  expect(sub.outcome).toBe("pending_approval");
  return post.id;
}

async function pendingChangeSet(actor: Actor, workspaceId: string, loc: Loc) {
  const fields = { title: `Clinic ${tok()}` };
  const p = await run<{ locations: { locationId: string; current: unknown }[] }>(
    actor,
    "profile.preview",
    { locationIds: [loc.row.id], fields },
  );
  const out = await run<{ changeSet: { id: string; status: string } }>(actor, "profile.propose", {
    workspaceId,
    locationIds: [loc.row.id],
    fields,
    snapshots: p.locations.map((l) => ({ locationId: l.locationId, current: l.current })),
  });
  expect(out.changeSet.status).toBe("pending_approval");
  return out.changeSet.id;
}

/** A post that is live on Google with one edit waiting for approval. Returns the edit id and the post id. */
async function pendingPostEdit(actor: Actor, approver: Actor, workspaceId: string, loc: Loc) {
  const { post } = await run<{ post: { id: string } }>(actor, "posts.createDraft", {
    workspaceId,
    locationIds: [loc.row.id],
    topicType: "STANDARD",
    summary: `Spring checkup week ${tok()}.`,
  });
  await run(actor, "posts.submit", { id: post.id, acknowledgeWarnings: true });
  await run(approver, "posts.approve", { id: post.id });
  await run(actor, "posts.schedule", { id: post.id });
  await processPostSend(db, { postId: post.id, occurrence: 0 }, { client: new ThrottledGoogleClient(mock, db) });
  const p = await run<{ outcome: string; edit: { id: string } | null }>(actor, "posts.proposeEdit", {
    id: post.id,
    summary: `New spring hours ${tok()}.`,
    acknowledgeWarnings: true,
  });
  expect(p.outcome).toBe("pending_approval");
  return { editId: p.edit!.id, postId: post.id };
}

/** An org with one waiting item of each kind, submission times fixed so the order is known. */
async function seed() {
  const org = await kit.makeOrg();
  const locA = await org.mkLoc(org.a);
  const locB = await org.mkLoc(org.b);
  await db.update(users).set({ name: "Olivia Owner" }).where(eq(users.id, org.ownerId));
  await db.update(users).set({ name: "Max Manager" }).where(eq(users.id, org.manager.userId));
  const mcp: Actor = { ...org.manager, surface: "mcp", actorType: "api_token" };

  const changeSet = await pendingChangeSet(org.manager, org.a, locA); // ui, Max, workspace A
  const replyB = await pendingReply(mcp, locB); // mcp, Max, workspace B
  const replyA = await pendingReply(org.owner, locA); // ui, Olivia, workspace A
  const post = await pendingPost(org.manager, org.a, locA); // ui, Max, workspace A
  const edit = await pendingPostEdit(org.manager, org.approverA, org.a, locA); // ui, Max, workspace A

  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 9, minute));
  await db.update(profileChangeSets).set({ submittedAt: at(0) }).where(eq(profileChangeSets.id, changeSet));
  await db.update(reviewReplies).set({ submittedAt: at(1) }).where(eq(reviewReplies.id, replyB));
  await db.update(reviewReplies).set({ submittedAt: at(2) }).where(eq(reviewReplies.id, replyA));
  await db.update(posts).set({ submittedAt: at(3) }).where(eq(posts.id, post));
  await db.update(postEdits).set({ createdAt: at(4) }).where(eq(postEdits.id, edit.editId));
  return { org, locA, locB, changeSet, replyA, replyB, post, edit };
}
type Seed = Awaited<ReturnType<typeof seed>>;

beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  setSharedMockGoogleClient(mock);
  setEmailSender(async () => {}, true);
  await boss.start();
  await boss.createQueue(POST_SEND_QUEUE);
  await boss.createQueue(POST_EDIT_QUEUE);
});
afterAll(async () => {
  await kit.deactivateAll();
  setEmailSender(null);
  setSharedMockGoogleClient(null);
  await boss.stop();
  await sql.end();
});

describe("approvals.queue", () => {
  let s: Seed;
  beforeAll(async () => {
    s = await seed();
  });

  it("returns replies, posts and change sets, oldest submission first, with counts", async () => {
    const q = await run<Queue>(s.org.owner, "approvals.queue");
    expect(q.items.map(keyOf)).toEqual([
      `changeset:${s.changeSet}`,
      `reply:${s.replyB}`,
      `reply:${s.replyA}`,
      `post:${s.post}`,
      `postedit:${s.edit.editId}`,
    ]);
    expect(q.counts).toEqual({ reply: 2, post: 1, changeset: 1, postedit: 1, total: 5 });
    expect(q.truncated).toBe(false);
  });

  it("a client approver sees only their workspace; staff can narrow with workspaceId", async () => {
    const a = await run<Queue>(s.org.approverA, "approvals.queue");
    expect(a.items.map(keyOf)).toEqual([
      `changeset:${s.changeSet}`,
      `reply:${s.replyA}`,
      `post:${s.post}`,
      `postedit:${s.edit.editId}`,
    ]);
    expect(a.counts).toEqual({ reply: 1, post: 1, changeset: 1, postedit: 1, total: 4 });
    const b = await run<Queue>(s.org.approverB, "approvals.queue");
    expect(b.items.map(keyOf)).toEqual([`reply:${s.replyB}`]);
    const narrowed = await run<Queue>(s.org.owner, "approvals.queue", { workspaceId: s.org.b });
    expect(narrowed.items.map(keyOf)).toEqual([`reply:${s.replyB}`]);
    expect(narrowed.counts.total).toBe(1);
  });

  it("locationIds narrows items and counts to those locations (a group or location scope)", async () => {
    const a = await run<Queue>(s.org.owner, "approvals.queue", { locationIds: [s.locA.row.id] });
    expect(a.items.map(keyOf)).toEqual([
      `changeset:${s.changeSet}`,
      `reply:${s.replyA}`,
      `post:${s.post}`,
      `postedit:${s.edit.editId}`,
    ]);
    expect(a.counts).toEqual({ reply: 1, post: 1, changeset: 1, postedit: 1, total: 4 });
    const b = await run<Queue>(s.org.owner, "approvals.queue", { locationIds: [s.locB.row.id] });
    expect(b.items.map(keyOf)).toEqual([`reply:${s.replyB}`]);
    expect(b.counts).toEqual({ reply: 1, post: 0, changeset: 0, postedit: 0, total: 1 });
    const both = await run<Queue>(s.org.owner, "approvals.queue", { locationIds: [s.locA.row.id, s.locB.row.id] });
    expect(both.counts.total).toBe(5);
    // counts agree with the queue
    expect(await run(s.org.owner, "approvals.counts", { locationIds: [s.locB.row.id] })).toEqual(b.counts);
    // canary: a location with nothing waiting gives an empty queue, not the whole one
    const none = await run<Queue>(s.org.owner, "approvals.queue", { locationIds: [s.org.a] });
    expect(none.counts.total).toBe(0);
  });

  it("groupId narrows to a group's active locations, whatever its size: no id list, so no 500 cap (H4)", async () => {
    const mk = async (name: string, ids: string[]) => {
      const [g] = await db.insert(locationGroups).values({ orgId: s.org.orgId, workspaceId: s.org.a, name }).returning();
      for (let i = 0; i < ids.length; i += 500) {
        await db.insert(locationGroupMembers).values(ids.slice(i, i + 500).map((locationId) => ({ groupId: g!.id, locationId, orgId: s.org.orgId })));
      }
      return g!.id;
    };
    // 600 more active locations, so the group is past what locationIds takes, plus one inactive member.
    const filler = await db
      .insert(locations)
      .values(
        Array.from({ length: 600 }, (_, i) => ({
          orgId: s.org.orgId,
          workspaceId: s.org.a,
          name: `Filler ${seq++}-${i}`,
          status: "active" as const,
        })),
      )
      .returning({ id: locations.id });
    const inactive = await db
      .insert(locations)
      .values({ orgId: s.org.orgId, workspaceId: s.org.a, name: `Gone ${seq++}`, status: "inactive" })
      .returning({ id: locations.id });
    const big = await mk(`Big ${seq++}`, [s.locA.row.id, ...filler.map((f) => f.id), inactive[0]!.id]);
    expect(filler.length + 1).toBeGreaterThan(500);

    const viaGroup = await run<Queue>(s.org.owner, "approvals.queue", { groupId: big });
    const viaIds = await run<Queue>(s.org.owner, "approvals.queue", { locationIds: [s.locA.row.id] });
    expect(viaGroup.items.map(keyOf)).toEqual(viaIds.items.map(keyOf));
    expect(viaGroup.counts).toEqual({ reply: 1, post: 1, changeset: 1, postedit: 1, total: 4 });
    expect(await run(s.org.owner, "approvals.counts", { groupId: big })).toEqual(viaGroup.counts);
    // the same ids as a list are refused past 500: that is the cap the group form avoids
    expect(await codeOf(run(s.org.owner, "approvals.counts", { locationIds: filler.map((f) => f.id) }))).toBe("INVALID_INPUT");

    // a group without the location with items, an empty group, and a group in another org's name give nothing
    const other = await mk(`Other ${seq++}`, [s.locB.row.id]);
    expect((await run<Queue>(s.org.owner, "approvals.queue", { groupId: other })).items.map(keyOf)).toEqual([`reply:${s.replyB}`]);
    expect((await run<Queue>(s.org.owner, "approvals.queue", { groupId: crypto.randomUUID() })).counts.total).toBe(0);
    // groupId or locationIds, not both
    expect(await codeOf(run(s.org.owner, "approvals.queue", { groupId: big, locationIds: [s.locA.row.id] }))).toBe("INVALID_INPUT");
  });

  it("a workspaceId outside the caller's scope is FORBIDDEN", async () => {
    expect(
      await codeOf(run(s.org.approverA, "approvals.queue", { workspaceId: s.org.b })),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(run(s.org.approverA, "approvals.counts", { workspaceId: s.org.b })),
    ).toBe("FORBIDDEN");
  });

  it("can.approve and can.reject come from the caller's role, not from the item", async () => {
    const approver = await run<Queue>(s.org.approverA, "approvals.queue");
    expect(approver.items.every((i) => i.can.approve && i.can.reject)).toBe(true);
    const viewer = await run<Queue>(s.org.viewerA, "approvals.queue");
    expect(viewer.items).toHaveLength(4);
    expect(viewer.items.every((i) => !i.can.approve && !i.can.reject)).toBe(true);
  });

  it("describes each kind of item", async () => {
    const q = await run<Queue>(s.org.owner, "approvals.queue");
    const reply = q.items.find((i) => i.id === s.replyA)!;
    expect(reply).toMatchObject({
      type: "reply",
      workspaceName: "A",
      locationNames: [s.locA.row.name],
      reviewId: expect.any(String),
      review: { rating: 2, comment: COMMENT, reviewerDisplayName: "Pat Reviewer" },
      title: "Reply to a 2★ review from Pat Reviewer",
      topicType: null,
      guardrail: { blocked: false, warnings: 0, warningsAcknowledged: false },
    });
    expect(reply.text).toContain("Thank you for telling us");
    const post = q.items.find((i) => i.id === s.post)!;
    expect(post).toMatchObject({
      type: "post",
      topicType: "STANDARD",
      locationNames: [s.locA.row.name],
      review: null,
      reviewId: null,
    });
    expect(post.title).toMatch(/^Update: Book online this week /);
    const edit = q.items.find((i) => i.id === s.edit.editId)!;
    expect(edit).toMatchObject({
      type: "postedit",
      postId: s.edit.postId,
      workspaceName: "A",
      locationNames: [s.locA.row.name],
      topicType: "STANDARD",
      review: null,
      reviewId: null,
    });
    expect(edit.title).toMatch(/^Edit to a live update: New spring hours /);
    expect(edit.text).toMatch(/^New spring hours /);
    expect(edit.submittedAt).toBe("2026-10-01T09:04:00.000Z");
    const cs = q.items.find((i) => i.id === s.changeSet)!;
    expect(cs).toMatchObject({
      type: "changeset",
      workspaceName: "A",
      locationNames: [s.locA.row.name],
      title: "Profile change: title on 1 location",
      review: null,
    });
    expect(cs.submittedAt).toBe("2026-10-01T09:00:00.000Z");
  });

  it("provenance tells an MCP draft from a person's, with the author's name", async () => {
    const q = await run<Queue>(s.org.owner, "approvals.queue");
    const by = (id: string) => q.items.find((i) => i.id === id)!.provenance;
    expect(by(s.replyB)).toEqual({ createdSurface: "mcp", createdByName: "Max Manager" });
    expect(by(s.replyA)).toEqual({ createdSurface: "ui", createdByName: "Olivia Owner" });
    // a change set has no submitter, so createdBy is used
    expect(by(s.changeSet)).toEqual({ createdSurface: "ui", createdByName: "Max Manager" });
  });

  it("limit truncates the items but the counts stay whole", async () => {
    const q = await run<Queue>(s.org.owner, "approvals.queue", { limit: 2 });
    expect(q.items).toHaveLength(2);
    expect(q.truncated).toBe(true);
    expect(q.counts.total).toBe(5);
  });

  it("every role that can read reviews can read locations, so the change-set branch widens no scope", () => {
    for (const role of Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[]) {
      if (roleHasPermission(role, "review:read")) {
        expect(roleHasPermission(role, "location:read"), role).toBe(true);
      }
    }
  });
});

describe("approvals.counts", () => {
  it("matches the queue, for staff and for a client approver", async () => {
    const s = await seed();
    for (const who of [s.org.owner, s.org.approverA, s.org.approverB]) {
      const q = await run<Queue>(who, "approvals.queue");
      expect(await run<Counts>(who, "approvals.counts")).toEqual(q.counts);
    }
    expect(await run<Counts>(s.org.owner, "approvals.counts")).toEqual({
      reply: 2,
      post: 1,
      changeset: 1,
      postedit: 1,
      total: 5,
    });
    expect(await run<Counts>(s.org.owner, "approvals.counts", { workspaceId: s.org.b })).toEqual({
      reply: 1,
      post: 0,
      changeset: 0,
      postedit: 0,
      total: 1,
    });
  });

  it("canary: an edit leaves the queue and the counts when its post's locations are all inactive", async () => {
    const s = await seed();
    expect((await run<Counts>(s.org.owner, "approvals.counts")).postedit).toBe(1);
    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, s.locA.row.id));
    const q = await run<Queue>(s.org.owner, "approvals.queue", { workspaceId: s.org.a });
    expect(q.items.map((i) => i.id)).not.toContain(s.edit.editId);
    expect(q.counts.postedit).toBe(0);
    expect(await run<Counts>(s.org.owner, "approvals.counts", { workspaceId: s.org.a })).toEqual(q.counts);
  });

  it("canary: a reply at an inactive location is in neither the queue nor the counts, like portal.overview", async () => {
    const s = await seed();
    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, s.locB.row.id));
    const q = await run<Queue>(s.org.owner, "approvals.queue");
    expect(q.items.map((i) => i.id)).not.toContain(s.replyB);
    expect(q.counts.reply).toBe(1);
    expect((await run<Counts>(s.org.owner, "approvals.counts")).reply).toBe(1);
    // and portal.overview agrees about the replies
    const portal = await run<{ pending: { id: string }[] }>(s.org.owner, "portal.overview");
    expect(portal.pending.map((p) => p.id)).not.toContain(s.replyB);
  });

  it("canary: a change set leaves the queue and the counts when every changing location is inactive", async () => {
    const s = await seed();
    const locA2 = await s.org.mkLoc(s.org.a);
    // a second change set over two locations; deactivating one keeps it, deactivating both drops it
    const fields = { title: `Clinic ${tok()}` };
    const p = await run<{ locations: { locationId: string; current: unknown }[] }>(
      s.org.manager,
      "profile.preview",
      { locationIds: [s.locA.row.id, locA2.row.id], fields },
    );
    const two = await run<{ changeSet: { id: string } }>(s.org.manager, "profile.propose", {
      workspaceId: s.org.a,
      locationIds: [s.locA.row.id, locA2.row.id],
      fields,
      snapshots: p.locations.map((l) => ({ locationId: l.locationId, current: l.current })),
    });

    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, locA2.row.id));
    let q = await run<Queue>(s.org.owner, "approvals.queue", { workspaceId: s.org.a });
    const kept = q.items.find((i) => i.id === two.changeSet.id)!;
    expect(kept.locationNames).toEqual([s.locA.row.name]);
    expect(kept.title).toBe("Profile change: title on 1 location");

    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, s.locA.row.id));
    q = await run<Queue>(s.org.owner, "approvals.queue", { workspaceId: s.org.a });
    expect(q.items.map((i) => i.id)).not.toContain(two.changeSet.id);
    expect(q.items.map((i) => i.id)).not.toContain(s.changeSet);
    expect(q.counts.changeset).toBe(0);
    expect(await run<Counts>(s.org.owner, "approvals.counts", { workspaceId: s.org.a })).toEqual(
      q.counts,
    );
    // posts are not filtered by location status (unchanged, follow-up 2)
    expect(q.items.map((i) => i.id)).toContain(s.post);
  });

  it("an item leaves the queue once it is approved or sent back", async () => {
    const s = await seed();
    await run(s.org.approverA, "reviewReplies.approve", { id: s.replyA });
    await run(s.org.approverA, "profile.reject", { id: s.changeSet, reason: "wrong name" });
    // An edit leaves on approve (same action as the post card) and on reject.
    await run(s.org.approverA, "posts.approveEdit", { id: s.edit.editId });
    const q = await run<Queue>(s.org.owner, "approvals.queue");
    expect(q.items.map(keyOf).sort()).toEqual([`post:${s.post}`, `reply:${s.replyB}`].sort());
    expect(await run<Counts>(s.org.owner, "approvals.counts")).toEqual(q.counts);

    const t = await seed();
    await run(t.org.approverA, "posts.rejectEdit", { id: t.edit.editId, reason: "wrong offer" });
    const q2 = await run<Queue>(t.org.owner, "approvals.queue");
    expect(q2.items.map((i) => i.id)).not.toContain(t.edit.editId);
    expect(q2.counts.postedit).toBe(0);
  });

  it("a post with an open edit is counted once, as an edit, never also as a post", async () => {
    const s = await seed();
    const q = await run<Queue>(s.org.owner, "approvals.queue");
    expect(q.items.filter((i) => i.type === "post" && i.id === s.edit.postId)).toHaveLength(0);
  });
});

describe("a pending edit of a published reply (F9)", () => {
  it("counts and lists once, as the pending row, in all four surfaces", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const review = await mkReview(loc, 2);
    // The reply that is live on Google: a published revision, plus the review's own copy of it.
    await db.insert(reviewReplies).values({
      orgId: review.orgId, workspaceId: review.workspaceId, reviewId: review.id, revision: 1,
      body: "Thanks for telling us.", status: "published", createdBy: org.ownerId, createdSurface: "ui", submittedAt: new Date(),
    });
    await db.update(reviews).set({ replyComment: "Thanks for telling us.", replyState: "ACCEPTED" }).where(eq(reviews.id, review.id));
    const { reply } = await run<{ reply: { id: string } }>(org.owner, "reviewReplies.createDraft", {
      reviewId: review.id,
      body: `Thank you for telling us. We have changed the way we book ${tok()}.`,
    });
    const sub = await run<{ outcome: string }>(org.owner, "reviewReplies.submit", { id: reply.id });
    expect(sub.outcome).toBe("pending_approval");

    const q = await run<Queue>(org.owner, "approvals.queue");
    expect(q.counts.reply).toBe(1);
    expect(q.items.filter((i) => i.type === "reply").map((i) => i.id)).toEqual([reply.id]);
    expect(await run<Counts>(org.owner, "approvals.counts")).toEqual(q.counts);
    type Att = { approvals: Counts };
    expect((await run<Att>(org.owner, "attention.counts")).approvals.reply).toBe(1);
    const list = await run<{ counts: Att; items: { kind: string; subject: string }[] }>(org.owner, "attention.queue");
    expect(list.counts.approvals.reply).toBe(1);
    expect(list.items.filter((i) => i.kind === "approval" && i.subject === "reply")).toHaveLength(1);
    // the client portal reads the same rows
    const portal = await run<{ pending: { id: string }[] }>(org.owner, "portal.overview");
    expect(portal.pending.map((i) => i.id)).toEqual([reply.id]);
  });
});

describe("one approvals count", () => {
  it("approvals.queue, approvals.counts, attention.counts and attention.queue report the same numbers", async () => {
    const s = await seed();
    type Att = { approvals: Counts };
    type AttList = { counts: Att; items: { kind: string; subject: string }[] };
    for (const ws of [undefined, s.org.a, s.org.b]) {
      const input = ws ? { workspaceId: ws } : {};
      const q = (await run<Queue>(s.org.owner, "approvals.queue", input)).counts;
      expect(q.total).toBeGreaterThan(0);
      expect(await run<Counts>(s.org.owner, "approvals.counts", input)).toEqual(q);
      expect((await run<Att>(s.org.owner, "attention.counts", input)).approvals).toEqual(q);
      const list = await run<AttList>(s.org.owner, "attention.queue", input);
      expect(list.counts.approvals).toEqual(q);
      const rows = list.items.filter((i) => i.kind === "approval");
      for (const t of ["reply", "post", "changeset", "postedit"] as const) {
        expect(rows.filter((i) => i.subject === t).length).toBe(q[t]);
      }
    }
    // Every type is seeded, so a type that dropped out of a surface cannot hide behind a zero.
    const all = await run<Counts>(s.org.owner, "approvals.counts");
    expect([all.reply, all.post, all.changeset, all.postedit].every((n) => n > 0)).toBe(true);
  });
});

describe("approval-queue pure helpers", () => {
  const result = (violations: { severity: "block" | "warn" }[]) =>
    ({
      ok: !violations.some((v) => v.severity === "block"),
      violations: violations.map((v, i) => ({
        ruleId: `X${i}`,
        packId: "universal",
        status: "active",
        message: "m",
        severity: v.severity,
      })),
      packs: ["universal"],
    }) as GuardrailResult;

  it("guardrailSummary counts blocks and warnings and carries the acknowledgement", () => {
    expect(guardrailSummary(null, false)).toEqual({
      blocked: false,
      warnings: 0,
      warningsAcknowledged: false,
    });
    expect(guardrailSummary(result([{ severity: "warn" }, { severity: "warn" }]), true)).toEqual({
      blocked: false,
      warnings: 2,
      warningsAcknowledged: true,
    });
    expect(guardrailSummary(result([{ severity: "block" }, { severity: "warn" }]), false)).toEqual({
      blocked: true,
      warnings: 1,
      warningsAcknowledged: false,
    });
  });

  it("titles read like the canvas", () => {
    expect(replyTitle(2, "Maria G.")).toBe("Reply to a 2★ review from Maria G.");
    expect(replyTitle(5, null)).toBe("Reply to a 5★ review");
    expect(replyTitle(null, null)).toBe("Reply to an unrated review");
    expect(postTitle("OFFER", "Free posture screening")).toBe("Offer: Free posture screening");
    expect(postTitle("STANDARD", "x".repeat(100))).toBe(`Update: ${"x".repeat(59)}…`);
    expect(changeSetTitle(["description", "title"], 6)).toBe(
      "Profile change: description, title on 6 locations",
    );
    expect(changeSetTitle(["title"], 1)).toBe("Profile change: title on 1 location");
  });
});
