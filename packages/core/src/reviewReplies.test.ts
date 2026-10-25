import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  auditLog,
  createDb,
  googleIdempotencyKeys,
  locations,
  memberships,
  organizations,
  reviewReplies,
  reviews,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { actions } from "./actions";
import { seedMockGoogleConnection } from "./google/dev-seed";
import { GoogleApiError } from "./google/errors";
import { MockGoogleClient } from "./google/mock-client";
import { ReadOnlyGoogleClient } from "./google/read-only-client";
import { ThrottledGoogleClient } from "./google/throttled-client";
import {
  processReplyDelete,
  processReplyPublish,
  REPLY_DELETE_QUEUE,
  REPLY_PUBLISH_QUEUE,
} from "./reviews/reply-jobs";
import type { WorkspaceReplySettings } from "./reviews/workspace-settings";

// Test seam for R4/G4 settings: the reply flow reads settings only through getWorkspaceReplySettings,
// so tests stub that one function per workspace and leave workspace-settings.ts untouched.
const settingsFor = vi.hoisted(() => new Map<string, Partial<WorkspaceReplySettings>>());
vi.mock("./reviews/workspace-settings", async (orig) => {
  const real = await orig<typeof import("./reviews/workspace-settings")>();
  return {
    ...real,
    getWorkspaceReplySettings: async (
      tx: Parameters<typeof real.getWorkspaceReplySettings>[0],
      workspaceId: string,
    ) => ({
      ...(await real.getWorkspaceReplySettings(tx, workspaceId)),
      ...settingsFor.get(workspaceId),
    }),
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
const mock = new MockGoogleClient();
const client = new ThrottledGoogleClient(mock, db);
const writes = (method: "updateReply" | "deleteReply") =>
  mock.calls.filter((c) => c.method === method).length;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? e.code : `other:${String(e)}`;
  }
  return "no error";
}

const run = <T = never>(actor: Actor, name: string, input: unknown = {}) =>
  executeAction(db, actor, name, input) as Promise<T>;

type Reply = {
  id: string;
  revision: number;
  status: string;
  body: string;
  publishPending: boolean;
  failureReason: string | null;
  autoApprovedMinStars: number | null;
  can: { edit: boolean; submit: boolean; approve: boolean; reject: boolean; publish: boolean };
};
type Violation = { ruleId: string; severity: string; status: string };
type SubmitOut = {
  outcome: string;
  code: string | null;
  reply: Reply;
  result: { ok: boolean; violations: Violation[] };
  publishQueued: boolean;
};

const STARS = ["ONE", "TWO", "THREE", "FOUR", "FIVE"] as const;

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
  const actor = (u: { id: string }, surface: Actor["surface"] = "ui") =>
    loadActor(db, { userId: u.id, surface, actorType: "user" });
  const { connectionId } = await seedMockGoogleConnection(db, owner.email);
  const mkLoc = async (workspaceId: string, name = "Clinic") => {
    const n = uniqDigits();
    const [l] = await db
      .insert(locations)
      .values({
        orgId,
        workspaceId,
        name,
        googleAccountName: `accounts/7${n.slice(-8)}`,
        googleLocationId: `locations/7${n.slice(-10)}`,
        connectionId,
        phone: "555-0100",
      })
      .returning();
    return l!;
  };
  /** A review in the DB and in the mock Google, so publishing it works. */
  const mkReview = async (
    loc: Awaited<ReturnType<typeof mkLoc>>,
    o: { rating?: 1 | 2 | 3 | 4 | 5; comment?: string; reply?: string } = {},
  ) => {
    const rating = o.rating ?? 5;
    const name = mock.addReview(loc.googleAccountName!, loc.googleLocationId!, {
      starRating: STARS[rating - 1],
      comment: o.comment ?? "Great place",
      ...(o.reply ? { reply: o.reply } : {}),
    });
    const now = new Date();
    // The mock stamps a reply with the review's create time; mirror it so the DB matches Google.
    const replyTime = o.reply
      ? new Date((await mock.getReview(name)).reviewReply!.updateTime)
      : null;
    const [r] = await db
      .insert(reviews)
      .values({
        orgId,
        workspaceId: loc.workspaceId,
        locationId: loc.id,
        googleReviewName: name,
        reviewerDisplayName: "Pat Reviewer",
        starRating: rating,
        comment: o.comment ?? "Great place",
        createTime: now,
        updateTime: now,
        replyComment: o.reply ?? null,
        replyUpdateTime: replyTime,
      })
      .returning();
    return r!;
  };
  return {
    orgId,
    a: a!.id,
    b: b!.id,
    owner: await actor(owner),
    manager: await actor(await mkUser("manager")),
    approverA: await actor(await mkUser("client_approver", a!.id)),
    viewerA: await actor(await mkUser("client_viewer", a!.id)),
    mkLoc,
    mkReview,
  };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;

const jobsFor = async (queue: string, key: string, value: string) =>
  (
    await sql<{ id: string }[]>`
      select id from pgboss.job where name = ${queue} and data->>${key} = ${value}`
  ).length;

/** draft -> submit -> (approve) with a unique clean body. */
async function approvedReply(org: Org, reviewId: string, body = `Thank you, ${uniq()}.`) {
  const { reply } = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
    reviewId,
    body,
  });
  const sub = await run<SubmitOut>(org.owner, "reviewReplies.submit", { id: reply.id });
  expect(sub.outcome).toBe("pending_approval");
  await run(org.manager, "reviewReplies.approve", { id: reply.id });
  return { id: reply.id, body };
}

const rowOf = async (id: string) =>
  (await db.select().from(reviewReplies).where(eq(reviewReplies.id, id)))[0]!;
const reviewOf = async (id: string) =>
  (await db.select().from(reviews).where(eq(reviews.id, id)))[0]!;

beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  await boss.start();
  await boss.createQueue(REPLY_PUBLISH_QUEUE);
  await boss.createQueue(REPLY_DELETE_QUEUE);
});
afterAll(async () => {
  await boss.stop();
  await sql.end();
});

describe("reply flow", () => {
  let org: Org;
  let loc: Awaited<ReturnType<Org["mkLoc"]>>;
  beforeAll(async () => {
    org = await makeOrg();
    loc = await org.mkLoc(org.a);
  });

  it("happy path: draft, submit, pending, approve, publish queues a job, the job publishes", async () => {
    const rev = await org.mkReview(loc);
    const body = `Thanks for choosing us ${uniq()}.`;
    const { reply } = await run<{ reply: Reply }>(org.manager, "reviewReplies.createDraft", {
      reviewId: rev.id,
      body,
    });
    expect(reply).toMatchObject({ status: "draft", revision: 1 });
    expect(reply.can).toMatchObject({ edit: true, submit: true, approve: false, publish: false });

    const sub = await run<SubmitOut>(org.manager, "reviewReplies.submit", { id: reply.id });
    expect(sub).toMatchObject({ outcome: "pending_approval", publishQueued: false });
    expect(sub.reply.can).toMatchObject({ approve: true, reject: true, edit: false });

    // pending replies cannot be published
    expect(await codeOf(run(org.owner, "reviewReplies.publish", { id: reply.id }))).toBe(
      "CONFLICT",
    );

    const approved = await run<{ reply: Reply }>(org.approverA, "reviewReplies.approve", {
      id: reply.id,
    });
    expect(approved.reply.status).toBe("approved");
    expect(approved.reply.can.publish).toBe(false); // client_approver: capability flag says no

    const before = writes("updateReply");
    const pub = await run<{ queued: boolean; reply: Reply }>(org.manager, "reviewReplies.publish", {
      id: reply.id,
    });
    expect(pub.queued).toBe(true);
    expect(pub.reply.publishPending).toBe(true);
    expect(writes("updateReply")).toBe(before); // the action never calls Google
    expect(await jobsFor(REPLY_PUBLISH_QUEUE, "replyId", reply.id)).toBe(1);
    expect((await rowOf(reply.id)).status).toBe("approved");

    expect(await processReplyPublish(db, reply.id, { client })).toBe("published");
    expect(writes("updateReply")).toBe(before + 1);
    const row = await rowOf(reply.id);
    expect(row.status).toBe("published");
    expect(row.publishedAt).not.toBeNull();
    expect((await reviewOf(rev.id)).replyComment).toBe(body);

    const audits = await db
      .select({ action: auditLog.action, surface: auditLog.surface })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.entityId, reply.id)));
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "review_reply.draft_created",
        "review_reply.submitted",
        "review_reply.approved",
        "review_reply.publish_requested",
        "review_reply.published",
      ]),
    );
    expect(audits.find((a) => a.action === "review_reply.published")!.surface).toBe("worker");
  });

  it("re-running the publish job does not call Google again (settled, and after a lost write)", async () => {
    const rev = await org.mkReview(loc);
    const { id } = await approvedReply(org, rev.id);
    await run(org.owner, "reviewReplies.publish", { id });
    const before = writes("updateReply");
    expect(await processReplyPublish(db, id, { client })).toBe("published");
    expect(await processReplyPublish(db, id, { client })).toBeNull(); // settled: nothing to do
    expect(writes("updateReply")).toBe(before + 1);

    // Simulate a crash after Google applied the write but before our row was updated.
    await db
      .update(reviewReplies)
      .set({ status: "approved", publishedAt: null })
      .where(eq(reviewReplies.id, id));
    expect(await processReplyPublish(db, id, { client })).toBe("published");
    expect(writes("updateReply")).toBe(before + 1); // idempotency key replayed the stored response
  });

  it("a block at submit (URL) sets blocked with violations; editing returns it to draft", async () => {
    const rev = await org.mkReview(loc);
    const { reply } = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
      reviewId: rev.id,
      body: "Visit https://example.com/offer today",
    });
    const sub = await run<SubmitOut>(org.owner, "reviewReplies.submit", { id: reply.id });
    expect(sub.outcome).toBe("blocked");
    expect(sub.result.ok).toBe(false);
    expect(sub.result.violations.map((v) => v.ruleId)).toContain("U7.url");
    expect(sub.reply.status).toBe("blocked");
    expect(sub.reply.can).toMatchObject({ edit: true, submit: false });
    const fixed = await run<{ reply: Reply }>(org.owner, "reviewReplies.updateDraft", {
      id: reply.id,
      body: `All the best ${uniq()}.`,
    });
    expect(fixed.reply.status).toBe("draft");
    // approved/pending replies cannot be edited
    const rev2 = await org.mkReview(loc);
    const ok = await approvedReply(org, rev2.id);
    expect(
      await codeOf(run(org.owner, "reviewReplies.updateDraft", { id: ok.id, body: "x" })),
    ).toBe("CONFLICT");
  });

  it("guardrails run again at publish: a duplicate that appeared in Google after approval blocks", async () => {
    const rev = await org.mkReview(loc);
    const { id, body } = await approvedReply(org, rev.id);
    // Someone replies with the same text to another review of this location in the Google UI.
    await org.mkReview(loc, { reply: body });
    await run(org.owner, "reviewReplies.publish", { id });
    const before = writes("updateReply");
    expect(await processReplyPublish(db, id, { client })).toBe("blocked");
    expect(writes("updateReply")).toBe(before);
    const row = await rowOf(id);
    expect(row.status).toBe("blocked");
    expect(row.publishRequestedAt).toBeNull();
    expect(
      (row.guardrailResult as { violations: Violation[] }).violations.map((v) => v.ruleId),
    ).toContain("R6.duplicate");
    const [a] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, id), eq(auditLog.action, "review_reply.blocked")));
    expect(a!.surface).toBe("worker");
  });

  it("warnings need acknowledgement on submit", async () => {
    const rev = await org.mkReview(loc);
    const { reply } = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
      reviewId: rev.id,
      body: `We appreciate your feedback ${uniq()}.`,
    });
    const first = await run<SubmitOut>(org.owner, "reviewReplies.submit", { id: reply.id });
    expect(first.outcome).toBe("needs_acknowledgement");
    expect(first.code).toBe("WARNINGS_REQUIRE_ACKNOWLEDGEMENT");
    expect(first.reply.status).toBe("draft");
    expect(first.result.violations.map((v) => v.ruleId)).toContain("U4");
    const second = await run<SubmitOut>(org.owner, "reviewReplies.submit", {
      id: reply.id,
      acknowledgeWarnings: true,
    });
    expect(second.outcome).toBe("pending_approval");
  });

  it("check is a dry run: reports violations and writes nothing", async () => {
    const rev = await org.mkReview(loc);
    const count = async () =>
      Number(
        (
          await sql<{ n: string }[]>`select count(*) n from audit_log where org_id = ${org.orgId}`
        )[0]!.n,
      );
    const audits = await count();
    const r = await run<{ ok: boolean; violations: Violation[] }>(
      org.viewerA,
      "reviewReplies.check",
      { reviewId: rev.id, body: "Email us: a@b.co" },
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.ruleId)).toContain("U7.email");
    expect(await count()).toBe(audits);
    expect(
      await db.select().from(reviewReplies).where(eq(reviewReplies.reviewId, rev.id)),
    ).toHaveLength(0);
  });

  it("one open revision per review: second createDraft is CONFLICT naming the open id", async () => {
    const rev = await org.mkReview(loc);
    const { reply } = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
      reviewId: rev.id,
      body: `One ${uniq()}`,
    });
    try {
      await run(org.manager, "reviewReplies.createDraft", { reviewId: rev.id, body: "Two" });
      expect.unreachable();
    } catch (e) {
      expect((e as CoreError).code).toBe("CONFLICT");
      expect((e as CoreError).message).toContain(reply.id);
    }
    const list = await run<{
      revisions: Reply[];
      review: { canDraft: boolean; openRevisionId: string };
    }>(org.owner, "reviewReplies.list", { reviewId: rev.id });
    expect(list.revisions).toHaveLength(1);
    expect(list.review).toMatchObject({ canDraft: false, openRevisionId: reply.id });
  });

  it("edit published: revision 2 publishes and revision 1 is superseded", async () => {
    const rev = await org.mkReview(loc);
    const first = await approvedReply(org, rev.id);
    await run(org.owner, "reviewReplies.publish", { id: first.id });
    await processReplyPublish(db, first.id, { client });

    const second = await approvedReply(org, rev.id, `Updated wording ${uniq()}.`);
    const row2 = await rowOf(second.id);
    expect(row2.revision).toBe(2);
    await run(org.owner, "reviewReplies.publish", { id: second.id });
    expect(await processReplyPublish(db, second.id, { client })).toBe("published");
    expect((await rowOf(first.id)).status).toBe("superseded");
    expect((await rowOf(second.id)).status).toBe("published");
    expect((await reviewOf(rev.id)).replyComment).toBe(second.body);
    const [{ n }] =
      (await sql`select count(*)::int n from review_replies where review_id = ${rev.id} and status = 'published'`) as [
        { n: number },
      ];
    expect(n).toBe(1);
  });

  it("delete published: Google reply removed, reviews.reply_comment null, revision deleted", async () => {
    const rev = await org.mkReview(loc);
    const { id } = await approvedReply(org, rev.id);
    await run(org.owner, "reviewReplies.publish", { id });
    await processReplyPublish(db, id, { client });

    const before = writes("deleteReply");
    expect(await run(org.manager, "reviewReplies.deletePublished", { reviewId: rev.id })).toEqual({
      queued: true,
    });
    expect(writes("deleteReply")).toBe(before); // action does not call Google
    expect(await jobsFor(REPLY_DELETE_QUEUE, "reviewId", rev.id)).toBe(1);
    const job = { reviewId: rev.id, requestedBy: "u" };
    expect(await processReplyDelete(db, job, { client })).toBe("deleted");
    expect(writes("deleteReply")).toBe(before + 1);
    expect((await reviewOf(rev.id)).replyComment).toBeNull();
    expect((await rowOf(id)).status).toBe("deleted");
    expect((await mock.getReview(rev.googleReviewName)).reviewReply).toBeUndefined();
    expect(await processReplyDelete(db, job, { client })).toBe("noop");
    // no reply left: nothing to delete
    expect(
      await codeOf(run(org.owner, "reviewReplies.deletePublished", { reviewId: rev.id })),
    ).toBe("CONFLICT");
  });

  it("Google 400 fails the reply with no retry; publish retries a failed reply", async () => {
    const rev = await org.mkReview(loc);
    const { id } = await approvedReply(org, rev.id);
    await run(org.owner, "reviewReplies.publish", { id });
    mock.failNext(1, () => new GoogleApiError(400, { error: "bad" }), "updateReply");
    const before = writes("updateReply");
    expect(await processReplyPublish(db, id, { client })).toBe("failed");
    expect(writes("updateReply")).toBe(before + 1);
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "failed", failureReason: "google_http_400" });

    const retry = await run<{ reply: Reply }>(org.owner, "reviewReplies.publish", { id });
    expect(retry.reply).toMatchObject({
      status: "approved",
      publishPending: true,
      failureReason: null,
    });
    expect(await processReplyPublish(db, id, { client })).toBe("published");
    const fails = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, id), eq(auditLog.action, "review_reply.failed")));
    expect(fails).toHaveLength(1);
  });

  it("audit rows never contain the reply or review text", async () => {
    const reviewText = `RVTEXT-${uniq()} back pain`;
    const rev = await org.mkReview(loc, { comment: reviewText });
    const bodyText = `BODYTEXT-${uniq()}`;
    const { id } = await approvedReply(org, rev.id, bodyText);
    await run(org.owner, "reviewReplies.publish", { id });
    await processReplyPublish(db, id, { client });
    // plus a blocked draft carrying a URL and the marker
    const rev2 = await org.mkReview(loc, { comment: reviewText });
    const { reply } = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
      reviewId: rev2.id,
      body: `BODYTEXT-blocked https://x.example/${uniq()}`,
    });
    await run(org.owner, "reviewReplies.submit", { id: reply.id });
    await run(org.owner, "reviewReplies.updateDraft", {
      id: reply.id,
      body: "BODYTEXT-edited-again",
    });
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.orgId), inArray(auditLog.entityId, [id, reply.id])));
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("BODYTEXT");
    expect(text).not.toContain("RVTEXT");
    expect(text).not.toContain("example.com");
    expect(text).toContain("bodySha256");
    console.log(`audit text check: ${rows.length} rows scanned, 0 contain body or review text`);
  });
});

describe("approval rules via decideApproval", () => {
  it("auto-approves 4-5 star replies per workspace settings, auto-publishes, never 1-3 star", async () => {
    const org = await makeOrg();
    const loc = await org.mkLoc(org.a);
    settingsFor.set(org.a, { autoApproveMinStars: 4, autoPublish: true });
    const five = await org.mkReview(loc, { rating: 5 });
    const three = await org.mkReview(loc, { rating: 3 });

    const d5 = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
      reviewId: five.id,
      body: `Glad to help ${uniq()}`,
    });
    const s5 = await run<SubmitOut>(org.owner, "reviewReplies.submit", { id: d5.reply.id });
    expect(s5).toMatchObject({ outcome: "approved", publishQueued: true });
    expect(await jobsFor(REPLY_PUBLISH_QUEUE, "replyId", d5.reply.id)).toBe(1);
    expect(await processReplyPublish(db, d5.reply.id, { client })).toBe("published");

    const d3 = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
      reviewId: three.id,
      body: `We are sorry ${uniq()}`,
    });
    const s3 = await run<SubmitOut>(org.owner, "reviewReplies.submit", { id: d3.reply.id });
    expect(s3).toMatchObject({ outcome: "pending_approval", publishQueued: false });
    expect(await jobsFor(REPLY_PUBLISH_QUEUE, "replyId", d3.reply.id)).toBe(0);
    settingsFor.delete(org.a);
  });

  it("autoApprovedMinStars is the rule that approved it; a manual approval reports null (canary)", async () => {
    const org = await makeOrg();
    const loc = await org.mkLoc(org.a);

    // Canary: with no rule, a person approves, and the field must say so.
    const r1 = await org.mkReview(loc, { rating: 5 });
    const d1 = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
      reviewId: r1.id,
      body: `Thanks for coming ${uniq()}`,
    });
    const s1 = await run<SubmitOut>(org.owner, "reviewReplies.submit", { id: d1.reply.id });
    expect(s1.outcome).toBe("pending_approval");
    expect(s1.reply.autoApprovedMinStars).toBeNull();
    const a1 = await run<{ reply: Reply }>(org.manager, "reviewReplies.approve", {
      id: d1.reply.id,
    });
    expect(a1.reply).toMatchObject({ status: "approved", autoApprovedMinStars: null });

    // The star rule approves a 5★ reply with nobody's approval.
    settingsFor.set(org.a, { autoApproveMinStars: 5 });
    const r2 = await org.mkReview(loc, { rating: 5 });
    const d2 = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
      reviewId: r2.id,
      body: `Glad you enjoyed it ${uniq()}`,
    });
    const s2 = await run<SubmitOut>(org.owner, "reviewReplies.submit", { id: d2.reply.id });
    expect(s2.outcome).toBe("approved");
    expect(s2.reply.autoApprovedMinStars).toBe(5);
    const listed = await run<{ revisions: Reply[] }>(org.owner, "reviewReplies.list", {
      reviewId: r2.id,
    });
    expect(listed.revisions[0]!.autoApprovedMinStars).toBe(5);
    settingsFor.delete(org.a);
  });

  it("records the rule's own number: a 5★ review approved under a 4★ rule reports 4", async () => {
    const org = await makeOrg();
    const loc = await org.mkLoc(org.a);
    settingsFor.set(org.a, { autoApproveMinStars: 4 });
    const r = await org.mkReview(loc, { rating: 5 });
    const d = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
      reviewId: r.id,
      body: `Thank you ${uniq()}`,
    });
    const sub = await run<SubmitOut>(org.owner, "reviewReplies.submit", { id: d.reply.id });
    expect(sub.reply).toMatchObject({ status: "approved", autoApprovedMinStars: 4 });
    // changing the setting afterwards does not rewrite history
    settingsFor.set(org.a, { autoApproveMinStars: 5 });
    const listed = await run<{ revisions: Reply[] }>(org.owner, "reviewReplies.list", {
      reviewId: r.id,
    });
    expect(listed.revisions[0]!.autoApprovedMinStars).toBe(4);
    settingsFor.delete(org.a);
  });

  it("a row that was auto-approved and is later submitted by hand does not keep the label", async () => {
    const org = await makeOrg();
    const loc = await org.mkLoc(org.a);
    settingsFor.set(org.a, { autoApproveMinStars: 5 });
    const r = await org.mkReview(loc, { rating: 5 });
    const d = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
      reviewId: r.id,
      body: `Thank you ${uniq()}`,
    });
    const auto = await run<SubmitOut>(org.owner, "reviewReplies.submit", { id: d.reply.id });
    expect(auto.reply).toMatchObject({ status: "approved", autoApprovedMinStars: 5 });

    // The publish job re-runs the guardrails; a block there puts the row at blocked, and editing
    // it returns it to draft. Simulate that end state, then turn the rule off and submit again.
    await db.update(reviewReplies).set({ status: "draft" }).where(eq(reviewReplies.id, d.reply.id));
    settingsFor.delete(org.a);
    const again = await run<SubmitOut>(org.owner, "reviewReplies.submit", { id: d.reply.id });
    expect(again.outcome).toBe("pending_approval");
    expect(again.reply.autoApprovedMinStars).toBeNull();
    // The old approved_at is still on the row, which is why a column is stored rather than derived.
    expect((await rowOf(d.reply.id)).approvedAt).not.toBeNull();
  });

  it("settings can enable a pack: hipaa blocks a reply that names the reviewer", async () => {
    const org = await makeOrg();
    const loc = await org.mkLoc(org.a);
    settingsFor.set(org.a, { profile: "healthcare", packs: ["hipaa"] });
    const rev = await org.mkReview(loc, { rating: 2 });
    const { reply } = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
      reviewId: rev.id,
      body: "Pat, thanks for visiting us.",
    });
    const sub = await run<SubmitOut>(org.owner, "reviewReplies.submit", { id: reply.id });
    expect(sub.outcome).toBe("blocked");
    expect(sub.result.violations.some((v) => v.ruleId.startsWith("H"))).toBe(true);
    settingsFor.delete(org.a);
  });
});

describe("roles and scope", () => {
  it("client_approver approves only in their workspace and cannot publish; viewer cannot write", async () => {
    const org = await makeOrg();
    const locA = await org.mkLoc(org.a);
    const locB = await org.mkLoc(org.b);
    const revA = await org.mkReview(locA);
    const revB = await org.mkReview(locB);
    const mkPending = async (reviewId: string) => {
      const { reply } = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
        reviewId,
        body: `Hello ${uniq()}`,
      });
      await run(org.owner, "reviewReplies.submit", { id: reply.id });
      return reply.id;
    };
    const a = await mkPending(revA.id);
    const b = await mkPending(revB.id);

    // approver of A: B's reply is invisible, A's can be approved
    expect(await codeOf(run(org.approverA, "reviewReplies.approve", { id: b }))).toBe("NOT_FOUND");
    expect((await rowOf(b)).status).toBe("pending_approval");
    const queue = await run<{ items: { reply: Reply }[] }>(
      org.approverA,
      "reviewReplies.listQueue",
      {
        status: "pending_approval",
      },
    );
    expect(queue.items.map((i) => i.reply.id)).toEqual([a]);
    expect(
      await codeOf(
        run(org.approverA, "reviewReplies.listQueue", {
          status: "pending_approval",
          workspaceId: org.b,
        }),
      ),
    ).toBe("FORBIDDEN");
    await run(org.approverA, "reviewReplies.approve", { id: a });
    expect((await rowOf(a)).status).toBe("approved");

    // approvers cannot publish, draft, submit or delete
    expect(await codeOf(run(org.approverA, "reviewReplies.publish", { id: a }))).toBe("FORBIDDEN");
    expect(
      await codeOf(
        run(org.approverA, "reviewReplies.createDraft", { reviewId: revA.id, body: "x" }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(run(org.approverA, "reviewReplies.deletePublished", { reviewId: revA.id })),
    ).toBe("FORBIDDEN");

    // viewer: every reply write is FORBIDDEN, reads work
    const writeNames = actions
      .filter((x) => x.name.startsWith("reviewReplies.") && x.kind === "write")
      .map((x) => x.name);
    expect(writeNames).toHaveLength(7);
    for (const name of writeNames) {
      expect(
        await codeOf(run(org.viewerA, name, { id: a, reviewId: revA.id, body: "x", reason: "x" })),
        name,
      ).toBe("FORBIDDEN");
    }
    const list = await run<{ revisions: Reply[] }>(org.viewerA, "reviewReplies.list", {
      reviewId: revA.id,
    });
    expect(list.revisions[0]!.can).toEqual({
      edit: false,
      submit: false,
      approve: false,
      reject: false,
      publish: false,
    });
    expect(await codeOf(run(org.viewerA, "reviewReplies.list", { reviewId: revB.id }))).toBe(
      "NOT_FOUND",
    );
    expect(await codeOf(run(org.viewerA, "reviewReplies.listQueue", { status: "failed" }))).toBe(
      "FORBIDDEN",
    );
  });

  it("reject returns to draft with the reason; replies at inactive locations are invisible", async () => {
    const org = await makeOrg();
    const loc = await org.mkLoc(org.a);
    const rev = await org.mkReview(loc);
    const { reply } = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
      reviewId: rev.id,
      body: `Hi ${uniq()}`,
    });
    await run(org.owner, "reviewReplies.submit", { id: reply.id });
    const rej = await run<{ reply: Reply }>(org.approverA, "reviewReplies.reject", {
      id: reply.id,
      reason: "Too casual",
    });
    expect(rej.reply).toMatchObject({ status: "draft" });
    expect((await rowOf(reply.id)).rejectReason).toBe("Too casual");
    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, loc.id));
    expect(
      await codeOf(run(org.owner, "reviewReplies.updateDraft", { id: reply.id, body: "y" })),
    ).toBe("NOT_FOUND");
  });

  it("the database refuses two open revisions for one review", async () => {
    const org = await makeOrg();
    const loc = await org.mkLoc(org.a);
    const rev = await org.mkReview(loc);
    const base = {
      orgId: org.orgId,
      workspaceId: org.a,
      reviewId: rev.id,
      body: "b",
      createdBy: (await db.select().from(users).limit(1))[0]!.id,
      createdSurface: "ui" as const,
    };
    await db.insert(reviewReplies).values({ ...base, revision: 1, status: "blocked" });
    await expect(
      db.insert(reviewReplies).values({ ...base, revision: 2, status: "draft" }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/review_replies_one_open_per_review/) },
    });
    await db.insert(reviewReplies).values({ ...base, revision: 3, status: "published" });
  });
});

describe("publish-time conflict check (0a)", () => {
  let org: Org;
  let loc: Awaited<ReturnType<Org["mkLoc"]>>;
  beforeAll(async () => {
    org = await makeOrg();
    loc = await org.mkLoc(org.a);
  });
  const calls = (method: string) => mock.calls.filter((c) => c.method === method).length;
  const publishJob = async (id: string) => {
    await run(org.owner, "reviewReplies.publish", { id });
    return processReplyPublish(db, id, { client });
  };
  const googleReply = async (name: string) =>
    (await mock.getReview(name)).reviewReply?.comment ?? null;

  it("createDraft snapshots Google's reply as the base (none, then our own)", async () => {
    const rev = await org.mkReview(loc);
    const first = await approvedReply(org, rev.id);
    expect(await rowOf(first.id)).toMatchObject({
      baseReplyComment: null,
      baseReplyUpdateTime: null,
    });
    expect(await publishJob(first.id)).toBe("published");
    const second = await approvedReply(org, rev.id, `Edit ${uniq()}.`);
    const row = await rowOf(second.id);
    expect(row.baseReplyComment).toBe(first.body);
    expect(row.baseReplyUpdateTime).toEqual((await reviewOf(rev.id)).replyUpdateTime);
  });

  it("base matches Google: re-fetches the review first, then publishes", async () => {
    const rev = await org.mkReview(loc);
    const { id } = await approvedReply(org, rev.id);
    await run(org.owner, "reviewReplies.publish", { id });
    const gets = calls("getReview");
    const writesBefore = calls("updateReply");
    expect(await processReplyPublish(db, id, { client })).toBe("published");
    expect(calls("getReview")).toBe(gets + 1);
    expect(calls("updateReply")).toBe(writesBefore + 1);
    // getReview comes before updateReply for this review
    const order = mock.calls.filter((c) => c.args[0] === rev.googleReviewName).map((c) => c.method);
    expect(order.indexOf("getReview")).toBeLessThan(order.indexOf("updateReply"));
  });

  it("edit-published flow: base is our own reply and still publishes", async () => {
    const rev = await org.mkReview(loc, { reply: `Original ${uniq()}` });
    const { id } = await approvedReply(org, rev.id, `Replacement ${uniq()}.`);
    const row = await rowOf(id);
    expect(row.baseReplyComment).toBe((await reviewOf(rev.id)).replyComment);
    expect(await publishJob(id)).toBe("published");
    expect(await googleReply(rev.googleReviewName)).toBe(row.body);
  });

  it("Google reply changed between draft and publish: conflict, no write, Google's reply recorded", async () => {
    const rev = await org.mkReview(loc, { reply: `Original ${uniq()}` });
    const { id, body } = await approvedReply(org, rev.id);
    const uiEdit = `Edited in the Google UI ${uniq()}`;
    mock.updateReview(rev.googleReviewName, { reply: uiEdit });
    await run(org.owner, "reviewReplies.publish", { id });
    const before = calls("updateReply");
    expect(await processReplyPublish(db, id, { client })).toBe("conflict");
    expect(calls("updateReply")).toBe(before);
    expect(await googleReply(rev.googleReviewName)).toBe(uiEdit);

    const row = await rowOf(id);
    expect(row).toMatchObject({
      status: "conflict",
      conflictGoogleComment: uiEdit,
      publishRequestedAt: null,
    });
    expect(row.conflictGoogleUpdateTime).not.toBeNull();
    expect(row.conflictDetectedAt).not.toBeNull();
    const r = await reviewOf(rev.id);
    expect(r.replyComment).toBe(uiEdit);
    expect(r.replyUpdateTime).toEqual(row.conflictGoogleUpdateTime);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, id), eq(auditLog.action, "review_reply.conflict")));
    expect(audit).toMatchObject({ surface: "worker" });
    const dump = JSON.stringify([audit!.before, audit!.after]);
    expect(dump).not.toContain(uiEdit);
    expect(dump).not.toContain(body);
    expect(audit!.after).toMatchObject({ status: "conflict", googleReplyPresent: true });

    // re-running a settled conflict does nothing
    expect(await processReplyPublish(db, id, { client })).toBeNull();
    expect(calls("updateReply")).toBe(before);
  });

  it("only the reply's update time changed (same text): conflict", async () => {
    const rev = await org.mkReview(loc, { reply: `Same text ${uniq()}` });
    const { id } = await approvedReply(org, rev.id);
    const same = (await reviewOf(rev.id)).replyComment!;
    mock.updateReview(rev.googleReviewName, {
      reply: same,
      updateTime: new Date(Date.now() + 60_000).toISOString(),
    });
    await run(org.owner, "reviewReplies.publish", { id });
    const before = calls("updateReply");
    expect(await processReplyPublish(db, id, { client })).toBe("conflict");
    expect(calls("updateReply")).toBe(before);
  });

  it("reply added in Google after a draft with no reply: conflict", async () => {
    const rev = await org.mkReview(loc);
    const { id } = await approvedReply(org, rev.id);
    mock.updateReview(rev.googleReviewName, { reply: `Added in UI ${uniq()}` });
    await run(org.owner, "reviewReplies.publish", { id });
    const before = calls("updateReply");
    expect(await processReplyPublish(db, id, { client })).toBe("conflict");
    expect(calls("updateReply")).toBe(before);
    expect((await rowOf(id)).conflictGoogleComment).toMatch(/^Added in UI/);
  });

  it("reply deleted in Google after the draft: conflict, review row cleared", async () => {
    const rev = await org.mkReview(loc, { reply: `Original ${uniq()}` });
    const { id } = await approvedReply(org, rev.id);
    mock.updateReview(rev.googleReviewName, { reply: null });
    await run(org.owner, "reviewReplies.publish", { id });
    const before = calls("updateReply");
    expect(await processReplyPublish(db, id, { client })).toBe("conflict");
    expect(calls("updateReply")).toBe(before);
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "conflict", conflictGoogleComment: null });
    expect(row.conflictGoogleUpdateTime).toBeNull();
    expect(row.baseReplyComment).not.toBeNull();
    const r = await reviewOf(rev.id);
    expect(r.replyComment).toBeNull();
    expect(r.replyUpdateTime).toBeNull();
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, id), eq(auditLog.action, "review_reply.conflict")));
    expect(audit!.after).toMatchObject({ googleReplyPresent: false, baseReplyPresent: true });
  });

  it("our own text already on Google (retry after a lost response): published, no second write", async () => {
    const rev = await org.mkReview(loc);
    const { id, body } = await approvedReply(org, rev.id);
    // Google applied our write (whitespace differs) but we never recorded it.
    mock.updateReview(rev.googleReviewName, { reply: `  ${body}\n` });
    await run(org.owner, "reviewReplies.publish", { id });
    const before = calls("updateReply");
    expect(await processReplyPublish(db, id, { client })).toBe("published");
    expect(calls("updateReply")).toBe(before);
    const row = await rowOf(id);
    expect(row.status).toBe("published");
    expect(row.publishedAt).not.toBeNull();
    expect((await reviewOf(rev.id)).replyComment).toBe(`  ${body}\n`);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, id), eq(auditLog.action, "review_reply.published")));
    expect(audit!.after).toMatchObject({ alreadyOnGoogle: true });
  });

  it("a getReview failure fails the reply (4xx) without writing; a transient error is rethrown", async () => {
    const rev = await org.mkReview(loc);
    const { id } = await approvedReply(org, rev.id);
    await run(org.owner, "reviewReplies.publish", { id });
    const before = calls("updateReply");
    mock.failNext(1, () => new GoogleApiError(404, { error: "gone" }), "getReview");
    expect(await processReplyPublish(db, id, { client })).toBe("failed");
    expect(await rowOf(id)).toMatchObject({ status: "failed", failureReason: "google_http_404" });
    expect(calls("updateReply")).toBe(before);

    const rev2 = await org.mkReview(loc);
    const b = await approvedReply(org, rev2.id);
    await run(org.owner, "reviewReplies.publish", { id: b.id });
    mock.failNext(1, () => new Error("socket hang up"), "getReview");
    await expect(processReplyPublish(db, b.id, { client })).rejects.toThrow("socket hang up");
    expect((await rowOf(b.id)).status).toBe("approved");
    expect(await processReplyPublish(db, b.id, { client })).toBe("published");
  });

  it("with Google writes off, publish fails at once as google_writes_disabled and leaves no idempotency key", async () => {
    // The wrapper chain createGoogleClient builds for live mode with GOOGLE_BUSINESS_WRITES unset.
    const readOnly = new ThrottledGoogleClient(new ReadOnlyGoogleClient(mock), db);
    const rev = await org.mkReview(loc);
    const { id } = await approvedReply(org, rev.id);
    await run(org.owner, "reviewReplies.publish", { id });
    expect(await processReplyPublish(db, id, { client: readOnly })).toBe("failed");
    expect(await rowOf(id)).toMatchObject({
      status: "failed",
      failureReason: "google_writes_disabled",
    });
    const keys = await db
      .select()
      .from(googleIdempotencyKeys)
      .where(
        and(
          eq(googleIdempotencyKeys.orgId, org.orgId),
          eq(googleIdempotencyKeys.key, `reply:${id}`),
        ),
      );
    expect(keys).toEqual([]);
  });

  it("a write refused by the read-only wrapper leaves no pending idempotency key", async () => {
    const readOnly = new ThrottledGoogleClient(new ReadOnlyGoogleClient(mock), db);
    const key = `reply:refused-${uniq()}`;
    await expect(
      readOnly.updateReply("accounts/1/locations/2/reviews/3", "Thanks.", {
        orgId: org.orgId,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    const keys = await db
      .select()
      .from(googleIdempotencyKeys)
      .where(and(eq(googleIdempotencyKeys.orgId, org.orgId), eq(googleIdempotencyKeys.key, key)));
    expect(keys).toEqual([]);
  });

  it("conflict is terminal and not open: a new revision snapshots the new base and publishes", async () => {
    const rev = await org.mkReview(loc, { reply: `Original ${uniq()}` });
    const first = await approvedReply(org, rev.id);
    const uiEdit = `UI edit ${uniq()}`;
    mock.updateReview(rev.googleReviewName, { reply: uiEdit });
    expect(await publishJob(first.id)).toBe("conflict");

    // no actions are offered on the conflicted reply; the review can take a new draft
    const list = await run<{
      revisions: (Reply & { conflictGoogleComment: string | null })[];
      review: { canDraft: boolean; openRevisionId: string | null };
    }>(org.owner, "reviewReplies.list", { reviewId: rev.id });
    expect(list.revisions[0]).toMatchObject({
      status: "conflict",
      conflictGoogleComment: uiEdit,
      can: { edit: false, submit: false, approve: false, reject: false, publish: false },
    });
    expect(list.review).toMatchObject({ canDraft: true, openRevisionId: null });
    expect(
      await codeOf(run(org.owner, "reviewReplies.updateDraft", { id: first.id, body: "x" })),
    ).toBe("CONFLICT");
    expect(await codeOf(run(org.owner, "reviewReplies.publish", { id: first.id }))).toBe(
      "CONFLICT",
    );

    // it shows in the attention queue
    const queue = await run<{ items: { reply: { id: string; status: string } }[] }>(
      org.manager,
      "reviewReplies.listQueue",
      { status: "conflict", workspaceId: org.a, limit: 100 },
    );
    expect(queue.items.map((i) => i.reply.id)).toContain(first.id);

    const second = await approvedReply(org, rev.id, `Fresh start ${uniq()}.`);
    const row2 = await rowOf(second.id);
    expect(row2.revision).toBe(2);
    expect(row2.baseReplyComment).toBe(uiEdit);
    expect(await publishJob(second.id)).toBe("published");
    expect(await googleReply(rev.googleReviewName)).toBe(second.body);
    expect((await rowOf(first.id)).status).toBe("conflict"); // history kept, not superseded
    const queueAfter = await run<{ items: { reply: { id: string } }[] }>(
      org.manager,
      "reviewReplies.listQueue",
      { status: "conflict", workspaceId: org.a, limit: 100 },
    );
    expect(queueAfter.items.map((i) => i.reply.id)).toContain(first.id);
  });
});

describe("H2 warn mode through the reply flow (0b)", () => {
  let org: Org;
  let loc: Awaited<ReturnType<Org["mkLoc"]>>;
  const wsKey = () => org.a;
  beforeAll(async () => {
    org = await makeOrg();
    loc = await org.mkLoc(org.a);
  });
  const useHipaa = (h2Severity: "block" | "warn") =>
    settingsFor.set(wsKey(), {
      profile: "healthcare",
      packs: ["hipaa"],
      skipPositiveReviews: false,
      h2Severity,
    });
  afterAll(() => settingsFor.delete(wsKey()));
  // The reviewer is "Pat Reviewer": using the name trips H2.reviewer.
  // Unique per use: an identical earlier reply at the location would trip the duplicate rule.
  const named = () => `Pat, we appreciate your note ${uniq()}.`;

  it("default block: a reply naming the reviewer is blocked at submit", async () => {
    useHipaa("block");
    const rev = await org.mkReview(loc);
    const { reply } = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
      reviewId: rev.id,
      body: named(),
    });
    const sub = await run<SubmitOut>(org.owner, "reviewReplies.submit", {
      id: reply.id,
      acknowledgeWarnings: true,
    });
    expect(sub.outcome).toBe("blocked");
    expect(sub.result.violations.find((v) => v.ruleId === "H2.reviewer")?.severity).toBe("block");
  });

  it("warn: same text needs acknowledgement, then publishes", async () => {
    useHipaa("warn");
    const rev = await org.mkReview(loc);
    const { reply } = await run<{ reply: Reply }>(org.owner, "reviewReplies.createDraft", {
      reviewId: rev.id,
      body: named(),
    });
    const first = await run<SubmitOut>(org.owner, "reviewReplies.submit", { id: reply.id });
    expect(first.outcome).toBe("needs_acknowledgement");
    expect(first.code).toBe("WARNINGS_REQUIRE_ACKNOWLEDGEMENT");
    expect(first.result.ok).toBe(true);
    expect(first.result.violations.find((v) => v.ruleId === "H2.reviewer")?.severity).toBe("warn");
    const second = await run<SubmitOut>(org.owner, "reviewReplies.submit", {
      id: reply.id,
      acknowledgeWarnings: true,
    });
    expect(second.outcome).toBe("pending_approval");
    await run(org.manager, "reviewReplies.approve", { id: reply.id });
    await run(org.owner, "reviewReplies.publish", { id: reply.id, acknowledgeWarnings: true });
    expect(await processReplyPublish(db, reply.id, { client })).toBe("published");
  });

  it("warnings that first appear at publish time fail the job until acknowledged; block mode blocks", async () => {
    // submitted while hipaa is off (clean), then the workspace turns hipaa on in warn mode
    settingsFor.delete(wsKey());
    const rev = await org.mkReview(loc);
    const a = await approvedReply(org, rev.id, named());
    useHipaa("warn");
    await run(org.owner, "reviewReplies.publish", { id: a.id });
    const before = writes("updateReply");
    expect(await processReplyPublish(db, a.id, { client })).toBe("failed");
    expect(await rowOf(a.id)).toMatchObject({
      status: "failed",
      failureReason: "warnings_require_acknowledgement",
    });
    expect(writes("updateReply")).toBe(before);
    await run(org.owner, "reviewReplies.publish", { id: a.id, acknowledgeWarnings: true });
    expect(await processReplyPublish(db, a.id, { client })).toBe("published");

    settingsFor.delete(wsKey());
    const rev2 = await org.mkReview(loc);
    const b = await approvedReply(org, rev2.id, named());
    useHipaa("block");
    await run(org.owner, "reviewReplies.publish", { id: b.id, acknowledgeWarnings: true });
    expect(await processReplyPublish(db, b.id, { client })).toBe("blocked");
  });
});
