import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  postTargets,
  posts,
  users,
  workspaceReplySettings,
  workspaces,
  googleIdempotencyKeys,
} from "@opengmb/db";
import { dayKey, zonedWallToUtc } from "./time";
import { loadActor, type Actor } from "./actor";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { seedMockGoogleConnection } from "./google/dev-seed";
import { setSharedMockGoogleClient } from "./google/factory";
import { GoogleApiError } from "./google/errors";
import { MockGoogleClient } from "./google/mock-client";
import { ReadOnlyGoogleClient } from "./google/read-only-client";
import { ThrottledGoogleClient } from "./google/throttled-client";
import {
  POST_DELETE_QUEUE,
  POST_SEND_QUEUE,
  processPostDelete,
  processPostSend,
  sweepDuePosts,
} from "./posts/jobs";
import { postPublishKey } from "./posts/publish";
import { nextOccurrence, occurrenceAt, type Recurrence } from "./posts/recurrence";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// Digits only, for Google ids (`locations/7<digits>`): the timestamp plus 9 random digits, so two files
// minting an id in the same millisecond cannot collide (stripping letters from uniq() could).
const uniqDigits = () => `${Date.now()}${randomInt(100_000_000, 1_000_000_000)}`;
/** Letters only, so a token never looks like a phone number to P.phone. */
const tok = () => Math.random().toString(36).slice(2, 10).replace(/\d/g, "q");
const mock = new MockGoogleClient();
const client = new ThrottledGoogleClient(mock, db);
const creates = () => mock.calls.filter((c) => c.method === "createLocalPost").length;
const deletes = () => mock.calls.filter((c) => c.method === "deleteLocalPost").length;

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

type Target = {
  id: string;
  locationId: string;
  occurrence: number;
  status: string;
  googlePostName: string | null;
  error: string | null;
};
type Post = {
  id: string;
  status: string;
  language: string;
  rejectedByName: string | null;
  occurrence: number;
  scheduledFor: string | null;
  targets: Target[];
  guardrail: { ok: boolean; violations: { ruleId: string; severity: string }[] } | null;
  can: Record<string, boolean>;
};
type Check = { ok: boolean; violations: { ruleId: string; severity: string }[]; packs: string[] };
type SubmitOut = { outcome: string; code: string | null; post: Post; result: Check };

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
        googleAccountName: `accounts/8${n.slice(-8)}`,
        googleLocationId: `locations/8${n.slice(-10)}`,
        connectionId,
        phone: "555-0100",
      })
      .returning();
    return l!;
  };
  return {
    orgId,
    a: a!.id,
    b: b!.id,
    owner: await actor(owner),
    manager: await actor(await mkUser("manager")),
    approverA: await actor(await mkUser("client_approver", a!.id)),
    viewerA: await actor(await mkUser("client_viewer", a!.id)),
    approverB: await actor(await mkUser("client_approver", b!.id)),
    mkLoc,
  };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;

const jobsFor = async (queue: string, postId: string) =>
  (
    await sql<{ id: string }[]>`
      select id from pgboss.job where name = ${queue} and data->>'postId' = ${postId}`
  ).length;

const rowOf = async (id: string) => (await db.select().from(posts).where(eq(posts.id, id)))[0]!;
const targetsOf = async (id: string) =>
  db.select().from(postTargets).where(eq(postTargets.postId, id));
const getPost = async (org: Org, id: string) =>
  (await run<{ post: Post }>(org.owner, "posts.get", { id })).post;

type Draft = Record<string, unknown>;
async function approvedPost(
  org: Org,
  workspaceId: string,
  locationIds: string[],
  over: Draft = {},
) {
  const { post } = await run<{ post: Post }>(org.manager, "posts.createDraft", {
    workspaceId,
    locationIds,
    topicType: "STANDARD",
    summary: `Open house this month ${tok()}.`,
    ...over,
  });
  const sub = await run<SubmitOut>(org.manager, "posts.submit", {
    id: post.id,
    acknowledgeWarnings: true,
  });
  expect(sub.outcome, JSON.stringify(sub.result.violations)).toBe("pending_approval");
  await run(org.approverA, "posts.approve", { id: post.id });
  return post.id;
}

const setSettings = (
  org: Org,
  workspaceId: string,
  v: Partial<typeof workspaceReplySettings.$inferInsert>,
) =>
  db
    .insert(workspaceReplySettings)
    .values({ workspaceId, orgId: org.orgId, ...v })
    .onConflictDoUpdate({ target: workspaceReplySettings.workspaceId, set: v });

const hour = 3_600_000;
const future = (ms = hour) => new Date(Math.ceil((Date.now() + ms) / 1000) * 1000);

beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  await boss.start();
  await boss.createQueue(POST_SEND_QUEUE);
  await boss.createQueue(POST_DELETE_QUEUE);
});
afterAll(async () => {
  await boss.stop();
  await sql.end();
});

describe("composer validation (posts.check)", () => {
  let org: Org;
  let loc: Awaited<ReturnType<Org["mkLoc"]>>;
  beforeAll(async () => {
    org = await makeOrg();
    loc = await org.mkLoc(org.a);
  });
  const check = (input: Draft) =>
    run<Check>(org.manager, "posts.check", { workspaceId: org.a, locationIds: [loc.id], ...input });
  const ids = (c: Check) => [...new Set(c.violations.map((v) => v.ruleId))];
  const event = {
    title: "Open house",
    startDate: "2026-11-02",
    startTime: "10:00",
    endDate: "2026-11-02",
    endTime: "14:00",
  };

  it("a clean post of each type passes", async () => {
    expect(
      await check({ topicType: "STANDARD", summary: "Book online via the button below." }),
    ).toMatchObject({ ok: true, violations: [], packs: ["universal", "post"] });
    expect((await check({ topicType: "EVENT", event })).ok).toBe(true);
    expect(
      (await check({ topicType: "OFFER", event, offer: { couponCode: "FALL" }, summary: "Fall." }))
        .ok,
    ).toBe(true);
    const alert = await check({ topicType: "ALERT", alertType: "COVID_19", summary: "Hours." });
    expect(alert.ok).toBe(true); // warns: Google disabled new alerts
    expect(ids(alert)).toEqual(["P.alert"]);
  });

  it("reports the content rules per topic type", async () => {
    expect(ids(await check({ topicType: "STANDARD", summary: "Call (713) 555-0142" }))).toEqual([
      "P.phone",
    ]);
    expect(ids(await check({ topicType: "STANDARD", summary: "a".repeat(1501) }))).toEqual([
      "P.length",
    ]);
    expect(
      ids(
        await check({
          topicType: "STANDARD",
          summary: "Pics",
          media: [
            { sourceUrl: "https://x.example.com/a.jpg" },
            { sourceUrl: "https://x.example.com/b.jpg" },
          ],
        }),
      ),
    ).toEqual(["P.images"]);
    expect(
      ids(await check({ topicType: "STANDARD", summary: "Go", cta: { actionType: "BOOK" } })),
    ).toEqual(["P.cta"]);
    expect(
      ids(
        await check({
          topicType: "STANDARD",
          summary: "Go",
          cta: { actionType: "CALL", url: "https://x.example.com" },
        }),
      ),
    ).toEqual(["P.cta"]);
    expect(ids(await check({ topicType: "EVENT", summary: "Join us" }))).toEqual(["P.event"]);
    expect(
      ids(await check({ topicType: "OFFER", summary: "Sale", offer: { couponCode: "X" } })),
    ).toEqual(["P.event"]);
    expect(ids(await check({ topicType: "ALERT", summary: "Hours" }))).toEqual(["P.alert"]);
    expect(ids(await check({ topicType: "STANDARD", summary: "" }))).toEqual(["P.summary"]);
  });

  it("reply-only rules do not run on posts; reply paths still ignore the post pack", async () => {
    const c = await check({
      topicType: "STANDARD",
      summary: "Thrilled to hear it! Free consultation, 20% off for new customers.",
    });
    expect(c).toMatchObject({ ok: true, violations: [] });
  });

  it("rejects malformed composer input (unknown topic or CTA type) before any rule runs", async () => {
    expect(await codeOf(check({ topicType: "PROMO", summary: "x" }))).toBe("INVALID_INPUT");
    expect(
      await codeOf(check({ topicType: "STANDARD", summary: "x", cta: { actionType: "BUY" } })),
    ).toBe("INVALID_INPUT");
  });

  it("writes nothing", async () => {
    const before = await db.select().from(posts).where(eq(posts.orgId, org.orgId));
    const audits = await db.select().from(auditLog).where(eq(auditLog.orgId, org.orgId));
    await check({ topicType: "STANDARD", summary: "Hello" });
    expect(await db.select().from(posts).where(eq(posts.orgId, org.orgId))).toHaveLength(
      before.length,
    );
    expect(await db.select().from(auditLog).where(eq(auditLog.orgId, org.orgId))).toHaveLength(
      audits.length,
    );
  });
});

describe("healthcare and legal workspaces", () => {
  let org: Org;
  let loc: Awaited<ReturnType<Org["mkLoc"]>>;
  beforeAll(async () => {
    org = await makeOrg();
    loc = await org.mkLoc(org.a);
  });
  const check = (summary: string) =>
    run<Check>(org.manager, "posts.check", {
      workspaceId: org.a,
      locationIds: [loc.id],
      topicType: "STANDARD",
      summary,
    });
  const ids = (c: Check) => [...new Set(c.violations.map((v) => v.ruleId))];

  it("healthcare applies H1, provider and staff names but not clinical terms, dates or skip-positive", async () => {
    await setSettings(org, org.a, {
      profile: "healthcare",
      packs: ["hipaa"],
      skipPositiveReviews: true,
      staffNames: ["Maria Lopez"],
    });
    expect(ids(await check("Book your appointment online today."))).toEqual(["H1"]);
    expect(ids(await check("Meet Dr. Pratt, joining us."))).toEqual(["H2.provider"]);
    expect(ids(await check("Welcome Maria Lopez to the desk."))).toEqual(["H2.staff"]);
    expect(
      ids(
        await check("We now offer x-ray imaging for back pain. Open Monday. Insurance accepted."),
      ),
    ).toEqual([]);
  });

  it("H2 warn mode downgrades the post-capable H2 rules too", async () => {
    await setSettings(org, org.a, { h2Severity: "warn" });
    const c = await check("Meet Dr. Pratt, joining us.");
    expect(c.ok).toBe(true);
    expect(c.violations).toMatchObject([{ ruleId: "H2.provider", severity: "warn" }]);
    await setSettings(org, org.a, { h2Severity: "block" });
  });

  it("legal applies LE3 and LE4 only", async () => {
    await setSettings(org, org.a, {
      profile: "legal",
      packs: ["legal_ethics"],
      skipPositiveReviews: false,
      staffNames: [],
    });
    expect(ids(await check("We guarantee results."))).toEqual(["LE3.guarantee"]);
    expect(ids(await check("Tell your friends about the workshop."))).toEqual(["LE4.testimonial"]);
    expect(ids(await check("Tell us about your case."))).toEqual([]);
  });
});

describe("post flow", () => {
  let org: Org;
  let locA: Awaited<ReturnType<Org["mkLoc"]>>;
  let locA2: Awaited<ReturnType<Org["mkLoc"]>>;
  beforeAll(async () => {
    org = await makeOrg();
    locA = await org.mkLoc(org.a, "North");
    locA2 = await org.mkLoc(org.a, "South");
  });

  it("happy path: draft, submit, approve, schedule now queues a job, the job publishes at every location", async () => {
    const summary = `Fall hours are posted ${tok()}.`;
    const { post } = await run<{ post: Post }>(org.manager, "posts.createDraft", {
      workspaceId: org.a,
      locationIds: [locA.id, locA2.id],
      topicType: "STANDARD",
      summary,
      cta: { actionType: "BOOK", url: "https://clinic.example.com/book" },
    });
    expect(post.status).toBe("draft");
    expect(post.targets.map((t) => t.status)).toEqual(["pending", "pending"]);
    expect(post.can).toMatchObject({ edit: true, submit: true, approve: false, schedule: false });

    const sub = await run<SubmitOut>(org.manager, "posts.submit", { id: post.id });
    expect(sub).toMatchObject({ outcome: "pending_approval" });
    expect(sub.post.can).toMatchObject({ approve: true, reject: true, edit: false });
    // not schedulable until approved
    expect(await codeOf(run(org.manager, "posts.schedule", { id: post.id }))).toBe("CONFLICT");

    const approved = await run<{ post: Post }>(org.approverA, "posts.approve", { id: post.id });
    expect(approved.post.status).toBe("approved");
    expect(approved.post.can.schedule).toBe(false); // client_approver may not schedule
    expect(await codeOf(run(org.approverA, "posts.schedule", { id: post.id }))).toBe("FORBIDDEN");

    const before = creates();
    const sched = await run<{ post: Post; sendQueued: boolean }>(org.manager, "posts.schedule", {
      id: post.id,
    });
    expect(sched.sendQueued).toBe(true);
    expect(sched.post.status).toBe("publishing");
    expect(creates()).toBe(before); // the action never calls Google
    expect(await jobsFor(POST_SEND_QUEUE, post.id)).toBe(1);

    expect(await processPostSend(db, { postId: post.id, occurrence: 0 }, { client })).toBe(
      "published",
    );
    expect(creates()).toBe(before + 2);
    const done = await getPost(org, post.id);
    expect(done.status).toBe("published");
    expect(done.targets.map((t) => t.status)).toEqual(["published", "published"]);
    expect(done.targets.every((t) => t.googlePostName?.includes("/localPosts/"))).toBe(true);
    // what reached Google
    const sent = mock.calls.filter((c) => c.method === "createLocalPost").slice(-2);
    expect((sent[0]!.args[1] as { summary: string; callToAction: unknown }).summary).toBe(summary);
    expect((sent[0]!.args[1] as { callToAction: unknown }).callToAction).toEqual({
      actionType: "BOOK",
      url: "https://clinic.example.com/book",
    });
    // re-running a settled post does nothing
    expect(await processPostSend(db, { postId: post.id, occurrence: 0 }, { client })).toBeNull();
    expect(creates()).toBe(before + 2);
  });

  it("a blocked submit can be fixed by editing, then resubmitted", async () => {
    const { post } = await run<{ post: Post }>(org.manager, "posts.createDraft", {
      workspaceId: org.a,
      locationIds: [locA.id],
      topicType: "STANDARD",
      summary: "Call (713) 555-0142 to book.",
    });
    const sub = await run<SubmitOut>(org.manager, "posts.submit", { id: post.id });
    expect(sub.outcome).toBe("blocked");
    expect(sub.post.status).toBe("blocked");
    expect(sub.result.violations.map((v) => v.ruleId)).toEqual(["P.phone"]);
    const edited = await run<{ post: Post }>(org.manager, "posts.updateDraft", {
      id: post.id,
      summary: "Tap the Call button to book.",
      cta: { actionType: "CALL" },
    });
    expect(edited.post.status).toBe("draft");
    expect(edited.post.guardrail).toBeNull();
    expect((await run<SubmitOut>(org.manager, "posts.submit", { id: post.id })).outcome).toBe(
      "pending_approval",
    );
    // pending posts cannot be edited
    expect(await codeOf(run(org.manager, "posts.updateDraft", { id: post.id, summary: "x" }))).toBe(
      "CONFLICT",
    );
  });

  it("warnings need explicit acknowledgement; reject returns a post to draft", async () => {
    const { post } = await run<{ post: Post }>(org.manager, "posts.createDraft", {
      workspaceId: org.a,
      locationIds: [locA.id],
      topicType: "ALERT",
      alertType: "COVID_19",
      summary: "Adjusted hours this week.",
    });
    const first = await run<SubmitOut>(org.manager, "posts.submit", { id: post.id });
    expect(first).toMatchObject({
      outcome: "needs_acknowledgement",
      code: "WARNINGS_REQUIRE_ACKNOWLEDGEMENT",
    });
    expect(first.post.status).toBe("draft");
    const second = await run<SubmitOut>(org.manager, "posts.submit", {
      id: post.id,
      acknowledgeWarnings: true,
    });
    expect(second.outcome).toBe("pending_approval");
    const rej = await run<{ post: Post }>(org.approverA, "posts.reject", {
      id: post.id,
      reason: "Needs rewording",
    });
    expect(rej.post.status).toBe("draft");
    expect((await rowOf(post.id)).rejectReason).toBe("Needs rewording");
  });

  it("posts always need manual approval: no auto-approve even if reply auto-approve is on", async () => {
    await setSettings(org, org.a, { autoApproveMinStars: 4, autoPublish: true });
    const { post } = await run<{ post: Post }>(org.manager, "posts.createDraft", {
      workspaceId: org.a,
      locationIds: [locA.id],
      topicType: "STANDARD",
      summary: `Hello ${tok()}`,
    });
    expect((await run<SubmitOut>(org.manager, "posts.submit", { id: post.id })).outcome).toBe(
      "pending_approval",
    );
    await setSettings(org, org.a, { autoApproveMinStars: null, autoPublish: false });
  });

  it("client roles: scoped to their workspace, viewers read only", async () => {
    const id = await approvedPost(org, org.a, [locA.id]);
    expect((await run<{ post: Post }>(org.viewerA, "posts.get", { id })).post.id).toBe(id);
    expect(
      await codeOf(
        run(org.viewerA, "posts.createDraft", {
          workspaceId: org.a,
          locationIds: [locA.id],
          topicType: "STANDARD",
          summary: "x",
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(await codeOf(run(org.approverB, "posts.get", { id }))).toBe("NOT_FOUND");
    expect(await codeOf(run(org.approverB, "posts.approve", { id }))).toBe("NOT_FOUND");
    const listB = await run<{ posts: Post[] }>(org.approverB, "posts.list", {});
    expect(listB.posts.some((p) => p.id === id)).toBe(false);
    const listA = await run<{ posts: Post[] }>(org.viewerA, "posts.list", { status: "approved" });
    expect(listA.posts.some((p) => p.id === id)).toBe(true);
    // a location from another workspace is not a valid target
    const locB = await org.mkLoc(org.b);
    expect(
      await codeOf(
        run(org.manager, "posts.createDraft", {
          workspaceId: org.a,
          locationIds: [locB.id],
          topicType: "STANDARD",
          summary: "x",
        }),
      ),
    ).toBe("INVALID_INPUT");
  });

  it("list filters: status, location, date range", async () => {
    const id = await approvedPost(org, org.a, [locA2.id]);
    const byLoc = await run<{ posts: Post[] }>(org.owner, "posts.list", { locationId: locA2.id });
    expect(byLoc.posts.some((p) => p.id === id)).toBe(true);
    const out = await run<{ posts: Post[] }>(org.owner, "posts.list", {
      workspaceId: org.a,
      status: "published",
      from: new Date(Date.now() + 10 * hour).toISOString(),
    });
    expect(out.posts).toEqual([]);
  });

  it("audit rows never contain post text, titles, terms, URLs or guardrail messages", async () => {
    const secret = {
      summary: `Secret summary ${tok()}`,
      title: `Secret title ${tok()}`,
      coupon: `CODE${tok()}`,
      terms: `Secret terms ${tok()}`,
      cta: `https://cta-${tok()}.example.com/go`,
      redeem: `https://redeem-${tok()}.example.com/r`,
      image: `https://img-${tok()}.example.com/p.jpg`,
    };
    const { post } = await run<{ post: Post }>(org.manager, "posts.createDraft", {
      workspaceId: org.a,
      locationIds: [locA.id],
      topicType: "OFFER",
      summary: `${secret.summary} Call (713) 555-0142`, // blocked at submit: matches quote the text
      cta: { actionType: "SHOP", url: secret.cta },
      event: {
        title: secret.title,
        startDate: "2026-11-02",
        endDate: "2026-11-03",
      },
      offer: {
        couponCode: secret.coupon,
        termsConditions: secret.terms,
        redeemOnlineUrl: secret.redeem,
      },
      media: [{ sourceUrl: secret.image }],
    });
    const blocked = await run<SubmitOut>(org.manager, "posts.submit", { id: post.id });
    expect(blocked.outcome).toBe("blocked");
    await run(org.manager, "posts.updateDraft", {
      id: post.id,
      summary: `${secret.summary} Tap Call.`,
      cta: null,
    });
    await run(org.manager, "posts.submit", { id: post.id, acknowledgeWarnings: true });
    await run(org.approverA, "posts.approve", { id: post.id });
    await run(org.manager, "posts.schedule", { id: post.id });
    await processPostSend(db, { postId: post.id, occurrence: 0 }, { client });
    await run(org.manager, "posts.deletePublished", { id: post.id });
    await processPostDelete(
      db,
      { postId: post.id, locationIds: null, requestedBy: "u" },
      { client },
    );

    const t = await targetsOf(post.id);
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, org.orgId),
          inArray(auditLog.entityId, [post.id, ...t.map((x) => x.id)]),
        ),
      );
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "post.draft_created",
        "post.blocked",
        "post.draft_updated",
        "post.submitted",
        "post.approved",
        "post.scheduled",
        "post.publish_started",
        "post.target_published",
        "post.published",
        "post.delete_requested",
        "post.target_deleted",
      ]),
    );
    const blob = JSON.stringify(rows);
    for (const [name, value] of Object.entries(secret)) {
      expect(blob.includes(value), `audit leaks ${name}`).toBe(false);
    }
    expect(blob).not.toContain("Call (713)");
    expect(blob).toMatch(/summarySha256/);
    expect(blob).toMatch(/summaryLength/);
    // surfaces: the worker wrote its rows
    expect(rows.filter((r) => r.action === "post.target_published")[0]!.surface).toBe("worker");
  });
});

describe("scheduling (fake clock)", () => {
  let org: Org;
  let loc: Awaited<ReturnType<Org["mkLoc"]>>;
  beforeAll(async () => {
    org = await makeOrg();
    loc = await org.mkLoc(org.a);
  });

  it("a future post is not sent before its time and is claimed exactly once at its time", async () => {
    const id = await approvedPost(org, org.a, [loc.id]);
    const T = future(2 * hour);
    const sched = await run<{ post: Post; sendQueued: boolean }>(org.manager, "posts.schedule", {
      id,
      scheduledFor: T.toISOString(),
    });
    expect(sched).toMatchObject({ sendQueued: false });
    expect(sched.post.status).toBe("scheduled");
    expect(await jobsFor(POST_SEND_QUEUE, id)).toBe(0);

    const before = creates();
    expect(
      (await sweepDuePosts(db, { orgIds: [org.orgId], now: new Date(T.getTime() - 60_000) }))
        .claimed,
    ).toBe(0);
    expect((await rowOf(id)).status).toBe("scheduled");
    expect(await processPostSend(db, { postId: id, occurrence: 0 }, { client })).toBeNull();
    expect(creates()).toBe(before);

    expect(
      (await sweepDuePosts(db, { orgIds: [org.orgId], now: T })).claimed,
    ).toBeGreaterThanOrEqual(1);
    expect((await rowOf(id)).status).toBe("publishing");
    expect(await jobsFor(POST_SEND_QUEUE, id)).toBe(1);
    await sweepDuePosts(db, { orgIds: [org.orgId], now: new Date(T.getTime() + 60_000) });
    expect(await jobsFor(POST_SEND_QUEUE, id)).toBe(1); // never claimed twice
    expect(creates()).toBe(before); // claiming does not call Google

    expect(await processPostSend(db, { postId: id, occurrence: 0 }, { client })).toBe("published");
    expect(creates()).toBe(before + 1);
  });

  it("09:00 local in Asia/Kolkata is stored as 03:30 UTC and is due at 03:30 UTC, not before", async () => {
    await run(org.owner, "workspaces.setTimeSettings", { workspaceId: org.a, timeZone: "Asia/Kolkata" });
    const id = await approvedPost(org, org.a, [loc.id]);
    const day = dayKey(Date.now() + 3 * 24 * hour, "Asia/Kolkata");
    const T = zonedWallToUtc(`${day}T09:00`, "Asia/Kolkata")!; // what the composer sends for 09:00 local
    expect(T.toISOString()).toBe(`${new Date(`${day}T03:30:00Z`).toISOString()}`);
    await run(org.manager, "posts.schedule", { id, scheduledFor: T.toISOString() });
    expect((await rowOf(id)).scheduledFor?.toISOString().slice(11, 16)).toBe("03:30");
    const at = (ms: number) => ({ orgIds: [org.orgId], now: new Date(T.getTime() + ms) });
    expect((await sweepDuePosts(db, at(-60_000))).claimed).toBe(0); // 03:29
    expect((await rowOf(id)).status).toBe("scheduled");
    expect((await sweepDuePosts(db, at(0))).claimed).toBeGreaterThanOrEqual(1); // 03:30
    expect((await rowOf(id)).status).toBe("publishing");
  });

  it("cancel before the time: nothing is sent; cancel while publishing is a CONFLICT", async () => {
    const id = await approvedPost(org, org.a, [loc.id]);
    const T = future(3 * hour);
    await run(org.manager, "posts.schedule", { id, scheduledFor: T.toISOString() });
    const c = await run<{ post: Post }>(org.manager, "posts.cancel", { id });
    expect(c.post.status).toBe("cancelled");
    expect(c.post.targets.map((t) => [t.status, t.error])).toEqual([["skipped", "cancelled"]]);
    await sweepDuePosts(db, { orgIds: [org.orgId], now: new Date(T.getTime() + hour) });
    expect((await rowOf(id)).status).toBe("cancelled");
    expect(await jobsFor(POST_SEND_QUEUE, id)).toBe(0);
    expect(await codeOf(run(org.manager, "posts.cancel", { id }))).toBe("CONFLICT");

    const id2 = await approvedPost(org, org.a, [loc.id]);
    await run(org.manager, "posts.schedule", { id: id2 }); // now: publishing
    expect(await codeOf(run(org.manager, "posts.cancel", { id: id2 }))).toBe("CONFLICT");
  });

  it("a draft can be cancelled; the past is refused", async () => {
    const { post } = await run<{ post: Post }>(org.manager, "posts.createDraft", {
      workspaceId: org.a,
      locationIds: [loc.id],
      topicType: "STANDARD",
      summary: "x",
    });
    expect(
      (await run<{ post: Post }>(org.manager, "posts.cancel", { id: post.id })).post.status,
    ).toBe("cancelled");
    const id = await approvedPost(org, org.a, [loc.id]);
    expect(
      await codeOf(
        run(org.manager, "posts.schedule", {
          id,
          scheduledFor: new Date(Date.now() - 2 * hour).toISOString(),
        }),
      ),
    ).toBe("INVALID_INPUT");
    expect(
      await codeOf(run(org.manager, "posts.schedule", { id, recurrence: { freq: "weekly" } })),
    ).toBe("INVALID_INPUT"); // neither until nor count
  });
});

describe("multi-location results", () => {
  let org: Org;
  let l1: Awaited<ReturnType<Org["mkLoc"]>>;
  let l2: Awaited<ReturnType<Org["mkLoc"]>>;
  beforeAll(async () => {
    org = await makeOrg();
    l1 = await org.mkLoc(org.a, "One");
    l2 = await org.mkLoc(org.a, "Two");
  });
  const sendNow = async (locs: string[], over: Draft = {}) => {
    const id = await approvedPost(org, org.a, locs, over);
    await run(org.manager, "posts.schedule", { id });
    return id;
  };

  it("one location failing does not stop the others: published with a per-location failure", async () => {
    const id = await sendNow([l1.id, l2.id]);
    mock.failNext(
      1,
      () => new GoogleApiError(400, { error: { message: "bad" } }),
      "createLocalPost",
    );
    expect(await processPostSend(db, { postId: id, occurrence: 0 }, { client })).toBe("published");
    const p = await getPost(org, id);
    const by = Object.fromEntries(p.targets.map((t) => [t.status, t]));
    expect(Object.keys(by).sort()).toEqual(["failed", "published"]);
    expect(by.failed!.error).toBe("google_http_400");
    expect(by.published!.googlePostName).toBeTruthy();
  });

  it("with Google writes off, the post fails at once as google_writes_disabled and leaves no idempotency key", async () => {
    const readOnly = new ThrottledGoogleClient(new ReadOnlyGoogleClient(mock), db);
    const id = await sendNow([l1.id]);
    expect(await processPostSend(db, { postId: id, occurrence: 0 }, { client: readOnly })).toBe(
      "failed",
    );
    expect((await getPost(org, id)).targets.map((t) => t.error)).toEqual([
      "google_writes_disabled",
    ]);
    const keys = await db
      .select({ key: googleIdempotencyKeys.key })
      .from(googleIdempotencyKeys)
      .where(eq(googleIdempotencyKeys.orgId, org.orgId));
    expect(keys.filter((k) => k.key.startsWith(`post:${id}:`))).toEqual([]);
  });

  it("every location failing fails the post", async () => {
    const id = await sendNow([l1.id, l2.id]);
    mock.failNext(
      2,
      () => new GoogleApiError(403, { error: { message: "no" } }),
      "createLocalPost",
    );
    expect(await processPostSend(db, { postId: id, occurrence: 0 }, { client })).toBe("failed");
    expect((await getPost(org, id)).targets.map((t) => t.error)).toEqual([
      "google_http_403",
      "google_http_403",
    ]);
  });

  it("an inactive location is skipped, the other still publishes", async () => {
    const id = await sendNow([l1.id, l2.id]);
    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, l2.id));
    try {
      expect(await processPostSend(db, { postId: id, occurrence: 0 }, { client })).toBe(
        "published",
      );
    } finally {
      await db.update(locations).set({ status: "active" }).where(eq(locations.id, l2.id));
    }
    const p = await getPost(org, id);
    expect(p.targets.map((t) => [t.locationId === l2.id, t.status]).sort()).toEqual([
      [false, "published"],
      [true, "skipped"],
    ]);
  });

  it("guardrails run again at send, per location: settings changed after approval block the send", async () => {
    const id = await sendNow([l1.id], { summary: `Book your appointment online ${tok()}.` });
    await setSettings(org, org.a, { profile: "healthcare", packs: ["hipaa"] });
    const before = creates();
    try {
      expect(await processPostSend(db, { postId: id, occurrence: 0 }, { client })).toBe("failed");
    } finally {
      await setSettings(org, org.a, { profile: "general", packs: [] });
    }
    expect(creates()).toBe(before); // nothing reached Google
    expect((await getPost(org, id)).targets[0]!.error).toBe("guardrail_blocked:H1");
  });

  it("warnings accepted at submit are accepted at send; unacknowledged ones fail the target", async () => {
    const id = await sendNow([l1.id], {
      topicType: "ALERT",
      alertType: "COVID_19",
      summary: "Adjusted hours.",
    });
    expect(await processPostSend(db, { postId: id, occurrence: 0 }, { client })).toBe("published");
    const id2 = await sendNow([l1.id], { summary: `Fine ${tok()}.` });
    await db
      .update(posts)
      .set({ topicType: "ALERT", alertType: "COVID_19" })
      .where(eq(posts.id, id2));
    expect(await processPostSend(db, { postId: id2, occurrence: 0 }, { client })).toBe("failed");
    expect((await getPost(org, id2)).targets[0]!.error).toBe("warnings_require_acknowledgement");
  });

  it("idempotent resend: a re-run after Google applied the create does not create twice", async () => {
    const id = await sendNow([l1.id]);
    const before = creates();
    expect(await processPostSend(db, { postId: id, occurrence: 0 }, { client })).toBe("published");
    expect(creates()).toBe(before + 1);
    const [t] = await targetsOf(id);
    // simulate a crash between Google's answer and our bookkeeping
    await db
      .update(postTargets)
      .set({ status: "pending", googlePostName: null, publishedAt: null })
      .where(eq(postTargets.id, t!.id));
    await db.update(posts).set({ status: "publishing" }).where(eq(posts.id, id));
    expect(await processPostSend(db, { postId: id, occurrence: 0 }, { client })).toBe("published");
    expect(creates()).toBe(before + 1); // idempotency key returned the stored response
    const [again] = await targetsOf(id);
    expect(again!.googlePostName).toBe(t!.googlePostName);
    const key = postPublishKey(id, l1.id, 0);
    expect(key).toBe(`post:${id}:${l1.id}:0`);
  });
});

describe("recurrence", () => {
  const rec = (over: Partial<Recurrence> = {}): Recurrence => ({
    freq: "weekly",
    interval: 1,
    anchor: "2026-01-31T09:00:00.000Z",
    ...over,
  });

  it("occurrence math: weekly, monthly from an anchor (no drift past short months)", () => {
    expect(occurrenceAt(rec(), 2).toISOString()).toBe("2026-02-14T09:00:00.000Z");
    expect(occurrenceAt(rec({ freq: "weekly", interval: 2 }), 1).toISOString()).toBe(
      "2026-02-14T09:00:00.000Z",
    );
    const m = rec({ freq: "monthly" });
    expect([0, 1, 2, 3].map((n) => occurrenceAt(m, n).toISOString())).toEqual([
      "2026-01-31T09:00:00.000Z",
      "2026-02-28T09:00:00.000Z",
      "2026-03-31T09:00:00.000Z",
      "2026-04-30T09:00:00.000Z",
    ]);
    expect(occurrenceAt(rec({ freq: "monthly", interval: 12 }), 1).toISOString()).toBe(
      "2027-01-31T09:00:00.000Z",
    );
  });

  it("with a time zone, a series keeps its local clock time across daylight-saving changes", () => {
    // Chicago: 09:00 CDT (14:00Z) before 2026-11-01, 09:00 CST (15:00Z) after.
    const chi = rec({ anchor: "2026-10-26T14:00:00.000Z", timeZone: "America/Chicago" });
    expect([0, 1, 2].map((n) => occurrenceAt(chi, n).toISOString())).toEqual([
      "2026-10-26T14:00:00.000Z",
      "2026-11-02T15:00:00.000Z",
      "2026-11-09T15:00:00.000Z",
    ]);
    // without the zone the same series drifts to 08:00 local
    expect(occurrenceAt({ ...chi, timeZone: undefined }, 1).toISOString()).toBe("2026-11-02T14:00:00.000Z");
    // Sydney monthly from the 31st: 09:00 AEDT (22:00Z the day before) in Jan, AEST... clamps to short months
    const syd = rec({ freq: "monthly", anchor: "2026-01-30T22:00:00.000Z", timeZone: "Australia/Sydney" }); // 31 Jan 09:00 AEDT
    expect([0, 1, 3].map((n) => occurrenceAt(syd, n).toISOString())).toEqual([
      "2026-01-30T22:00:00.000Z", // 31 Jan 09:00 +11
      "2026-02-27T22:00:00.000Z", // 28 Feb 09:00 +11
      "2026-04-29T23:00:00.000Z", // 30 Apr 09:00 +10 (AEDT ended 5 Apr)
    ]);
    // Kolkata has no DST: identical to UTC arithmetic
    const ind = rec({ anchor: "2026-10-19T03:30:00.000Z", timeZone: "Asia/Kolkata" });
    expect(occurrenceAt(ind, 1).toISOString()).toBe("2026-10-26T03:30:00.000Z");
  });

  it("respects count (total including the first) and until (inclusive)", () => {
    expect(nextOccurrence(rec({ count: 3 }), 1)?.index).toBe(2);
    expect(nextOccurrence(rec({ count: 3 }), 2)).toBeNull();
    const until = "2026-02-14T09:00:00.000Z";
    expect(nextOccurrence(rec({ until }), 1)?.at.toISOString()).toBe(until);
    expect(nextOccurrence(rec({ until }), 2)).toBeNull();
  });

  it("skips occurrences that are already past instead of flooding", () => {
    const n = nextOccurrence(rec({ count: 10 }), 0, new Date("2026-02-20T00:00:00.000Z"));
    expect(n).toMatchObject({ index: 3, skipped: 2 });
    expect(n!.at.toISOString()).toBe("2026-02-21T09:00:00.000Z");
  });

  describe("through the actions", () => {
    let org: Org;
    let loc: Awaited<ReturnType<Org["mkLoc"]>>;
    beforeAll(async () => {
      org = await makeOrg();
      loc = await org.mkLoc(org.a);
    });

    it("a weekly series of 3 sends three times and then ends", async () => {
      const id = await approvedPost(org, org.a, [loc.id]);
      const T = future(2 * hour);
      const week = 7 * 24 * hour;
      const s = await run<{ post: Post }>(org.manager, "posts.schedule", {
        id,
        scheduledFor: T.toISOString(),
        recurrence: { freq: "weekly", count: 3 },
      });
      expect(s.post.status).toBe("scheduled");
      const before = creates();

      await sweepDuePosts(db, { orgIds: [org.orgId], now: T });
      expect(await processPostSend(db, { postId: id, occurrence: 0 }, { client, now: T })).toBe(
        "scheduled",
      );
      let p = await rowOf(id);
      expect([p.occurrence, p.scheduledFor?.toISOString()]).toEqual([
        1,
        new Date(T.getTime() + week).toISOString(),
      ]);
      expect(creates()).toBe(before + 1);
      expect(await jobsFor(POST_SEND_QUEUE, id)).toBe(1);

      const T1 = new Date(T.getTime() + week);
      expect(
        (await sweepDuePosts(db, { orgIds: [org.orgId], now: new Date(T1.getTime() - 1000) }))
          .claimed,
      ).toBe(0);
      await sweepDuePosts(db, { orgIds: [org.orgId], now: T1 });
      expect(await processPostSend(db, { postId: id, occurrence: 1 }, { client, now: T1 })).toBe(
        "scheduled",
      );
      const T2 = new Date(T.getTime() + 2 * week);
      await sweepDuePosts(db, { orgIds: [org.orgId], now: T2 });
      expect(await processPostSend(db, { postId: id, occurrence: 2 }, { client, now: T2 })).toBe(
        "published",
      );
      p = await rowOf(id);
      expect(p.status).toBe("published");
      expect(creates()).toBe(before + 3);
      const t = await targetsOf(id);
      expect(t.map((x) => [x.occurrence, x.status]).sort()).toEqual([
        [0, "published"],
        [1, "published"],
        [2, "published"],
      ]);
      // a stale job for an old occurrence does nothing
      expect(await processPostSend(db, { postId: id, occurrence: 0 }, { client })).toBeNull();
      expect(creates()).toBe(before + 3);
    });

    it("cancelling a series stops it", async () => {
      const id = await approvedPost(org, org.a, [loc.id]);
      const T = future(2 * hour);
      await run(org.manager, "posts.schedule", {
        id,
        scheduledFor: T.toISOString(),
        recurrence: { freq: "weekly", count: 3 },
      });
      await sweepDuePosts(db, { orgIds: [org.orgId], now: T });
      await processPostSend(db, { postId: id, occurrence: 0 }, { client, now: T });
      await run(org.manager, "posts.cancel", { id });
      const T1 = new Date(T.getTime() + 7 * 24 * hour);
      await sweepDuePosts(db, { orgIds: [org.orgId], now: T1 });
      expect((await rowOf(id)).status).toBe("cancelled");
      expect(await jobsFor(POST_SEND_QUEUE, id)).toBe(1);
    });

    it("calendar: scheduled + projected occurrences inside the window only, plus past results", async () => {
      const id = await approvedPost(org, org.a, [loc.id]);
      const T = new Date(Date.UTC(2031, 0, 6, 9, 0, 0)); // far future, unique to this test
      await run(org.manager, "posts.schedule", {
        id,
        scheduledFor: T.toISOString(),
        recurrence: { freq: "weekly", count: 10 },
      });
      const day = 24 * hour;
      const win = (fromDays: number, toDays: number) =>
        run<{
          entries: { postId: string; occurrence: number; kind: string; at: string }[];
          truncated: boolean;
        }>(org.owner, "posts.calendar", {
          from: new Date(T.getTime() + fromDays * day).toISOString(),
          to: new Date(T.getTime() + toDays * day).toISOString(),
          workspaceId: org.a,
        });
      const mine = (r: Awaited<ReturnType<typeof win>>) => r.entries.filter((e) => e.postId === id);
      // days 0..21 cover occurrences 0, 1, 2 (day 0, 7, 14); day 21 is excluded
      expect(mine(await win(0, 21)).map((e) => [e.occurrence, e.kind])).toEqual([
        [0, "scheduled"],
        [1, "projected"],
        [2, "projected"],
      ]);
      // a later window: only the occurrences inside it, never earlier ones
      expect(mine(await win(20, 36)).map((e) => e.occurrence)).toEqual([3, 4, 5]);
      // count bounds the series: nothing after occurrence 9 (day 63)
      expect(mine(await win(60, 200)).map((e) => e.occurrence)).toEqual([9]);
      // window limits
      expect(
        await codeOf(
          run(org.owner, "posts.calendar", {
            from: T.toISOString(),
            to: new Date(T.getTime() + 400 * day).toISOString(),
          }),
        ),
      ).toBe("INVALID_INPUT");
      expect(
        await codeOf(
          run(org.owner, "posts.calendar", { from: T.toISOString(), to: T.toISOString() }),
        ),
      ).toBe("INVALID_INPUT");
      // scoped: another workspace's client sees nothing of it
      const other = await run<{ entries: { postId: string }[] }>(org.approverB, "posts.calendar", {
        from: new Date(T.getTime() - day).toISOString(),
        to: new Date(T.getTime() + 30 * day).toISOString(),
      });
      expect(other.entries.some((e) => e.postId === id)).toBe(false);
      // locationIds narrows to a group or location: the post's own location keeps it, another drops it
      const around = { from: new Date(T.getTime() - day).toISOString(), to: new Date(T.getTime() + 30 * day).toISOString() };
      const own = await run<{ entries: { postId: string }[] }>(org.owner, "posts.calendar", { ...around, locationIds: [loc.id] });
      expect(own.entries.some((e) => e.postId === id)).toBe(true);
      const elsewhere = await run<{ entries: { postId: string }[] }>(org.owner, "posts.calendar", { ...around, locationIds: [(await org.mkLoc(org.a)).id] });
      expect(elsewhere.entries.some((e) => e.postId === id)).toBe(false);
      // groupId does the same through the group's members, resolved on the server (a group scope of any size)
      const [g] = await db.insert(locationGroups).values({ orgId: org.orgId, workspaceId: org.a, name: `Cal ${randomInt(1e9)}` }).returning();
      await db.insert(locationGroupMembers).values({ groupId: g!.id, locationId: loc.id, orgId: org.orgId });
      const inGroup = await run<{ entries: { postId: string }[] }>(org.owner, "posts.calendar", { ...around, groupId: g!.id });
      expect(inGroup.entries.some((e) => e.postId === id)).toBe(true);
      const [empty] = await db.insert(locationGroups).values({ orgId: org.orgId, workspaceId: org.a, name: `Empty ${randomInt(1e9)}` }).returning();
      const outGroup = await run<{ entries: { postId: string }[] }>(org.owner, "posts.calendar", { ...around, groupId: empty!.id });
      expect(outGroup.entries.some((e) => e.postId === id)).toBe(false);
    });

    it("calendar shows past sends grouped per occurrence with location counts", async () => {
      const l2 = await org.mkLoc(org.a, "Second");
      const id = await approvedPost(org, org.a, [loc.id, l2.id]);
      await run(org.manager, "posts.schedule", { id });
      mock.failNext(1, () => new GoogleApiError(400, {}), "createLocalPost");
      await processPostSend(db, { postId: id, occurrence: 0 }, { client });
      const r = await run<{
        entries: { postId: string; kind: string; counts: { published: number; failed: number } }[];
      }>(org.owner, "posts.calendar", {
        from: new Date(Date.now() - hour).toISOString(),
        to: new Date(Date.now() + hour).toISOString(),
        workspaceId: org.a,
      });
      const e = r.entries.filter((x) => x.postId === id);
      expect(e).toHaveLength(1);
      expect(e[0]).toMatchObject({ kind: "published", counts: { published: 1, failed: 1 } });
    });
  });
});

describe("delete published", () => {
  let org: Org;
  let l1: Awaited<ReturnType<Org["mkLoc"]>>;
  let l2: Awaited<ReturnType<Org["mkLoc"]>>;
  beforeAll(async () => {
    org = await makeOrg();
    l1 = await org.mkLoc(org.a, "One");
    l2 = await org.mkLoc(org.a, "Two");
  });
  const published = async () => {
    const id = await approvedPost(org, org.a, [l1.id, l2.id]);
    await run(org.manager, "posts.schedule", { id });
    await processPostSend(db, { postId: id, occurrence: 0 }, { client });
    return id;
  };

  it("queues a job (no Google call), then removes the Google posts; a second request is a CONFLICT", async () => {
    const id = await published();
    const before = deletes();
    const q = await run<{ queued: boolean; targetCount: number }>(
      org.manager,
      "posts.deletePublished",
      {
        id,
      },
    );
    expect(q).toEqual({ queued: true, targetCount: 2 });
    expect(deletes()).toBe(before);
    expect(await jobsFor(POST_DELETE_QUEUE, id)).toBe(1);
    const r = await processPostDelete(
      db,
      { postId: id, locationIds: null, requestedBy: "u" },
      { client },
    );
    expect(r).toEqual({ deleted: 2, failed: 0 });
    expect(deletes()).toBe(before + 2);
    expect((await getPost(org, id)).targets.map((t) => t.status)).toEqual(["deleted", "deleted"]);
    expect(await codeOf(run(org.manager, "posts.deletePublished", { id }))).toBe("CONFLICT");
  });

  it("can target one location; a post already gone on Google (404) counts as deleted", async () => {
    const id = await published();
    const [first] = (await getPost(org, id)).targets;
    await run(org.manager, "posts.deletePublished", { id, locationIds: [first!.locationId] });
    await mock.deleteLocalPost(first!.googlePostName!); // removed in the Google UI meanwhile
    const r = await processPostDelete(
      db,
      { postId: id, locationIds: [first!.locationId], requestedBy: "u" },
      { client },
    );
    expect(r).toEqual({ deleted: 1, failed: 0 });
    const t = (await getPost(org, id)).targets;
    expect(t.find((x) => x.locationId === first!.locationId)!.status).toBe("deleted");
    expect(t.find((x) => x.locationId !== first!.locationId)!.status).toBe("published");
  });

  it("a Google failure keeps the target published with a reason", async () => {
    const id = await published();
    await run(org.manager, "posts.deletePublished", { id });
    mock.failNext(1, () => new GoogleApiError(403, {}), "deleteLocalPost");
    const r = await processPostDelete(
      db,
      { postId: id, locationIds: null, requestedBy: "u" },
      { client },
    );
    expect(r).toEqual({ deleted: 1, failed: 1 });
    const t = (await getPost(org, id)).targets;
    expect(t.map((x) => x.status).sort()).toEqual(["deleted", "published"]);
    expect(t.find((x) => x.status === "published")!.error).toBe("delete_failed:google_http_403");
  });

  it("needs review:publish and a post to delete", async () => {
    const id = await approvedPost(org, org.a, [l1.id]);
    expect(await codeOf(run(org.manager, "posts.deletePublished", { id }))).toBe("CONFLICT");
    expect(await codeOf(run(org.approverA, "posts.deletePublished", { id }))).toBe("FORBIDDEN");
  });
});

describe("posts.googleList (live read of what is on Google)", () => {
  let org: Org;
  let loc: Awaited<ReturnType<Org["mkLoc"]>>;
  beforeAll(async () => {
    org = await makeOrg();
    loc = await org.mkLoc(org.a);
    setSharedMockGoogleClient(mock); // the action builds its own client
  });
  afterAll(() => setSharedMockGoogleClient(null));

  it("lists every Google post made outside the app, none marked as published here", async () => {
    const parent = `${loc.googleAccountName}/${loc.googleLocationId}`;
    const made = [];
    for (let i = 0; i < 3; i++) {
      made.push(
        await mock.createLocalPost(parent, {
          topicType: "STANDARD",
          summary: `Made in the Google UI ${i}`,
          languageCode: "en",
        }),
      );
    }
    const out = await run<{
      posts: { name: string; summary: string | null; state: string | null; managedHere: boolean }[];
      truncated: boolean;
    }>(org.manager, "posts.googleList", { locationId: loc.id });
    expect(out.truncated).toBe(false);
    expect(out.posts.map((p) => p.summary).sort()).toEqual([
      "Made in the Google UI 0",
      "Made in the Google UI 1",
      "Made in the Google UI 2",
    ]);
    expect(out.posts.every((p) => p.state === "LIVE" && !p.managedHere)).toBe(true);
  });

  it("client roles in another workspace cannot read it", async () => {
    const other = await org.mkLoc(org.b, "Other");
    await expect(
      run(org.viewerA, "posts.googleList", { locationId: other.id }),
    ).rejects.toBeInstanceOf(CoreError);
  });
});

describe("post language", () => {
  let org: Org;
  let loc: Awaited<ReturnType<Org["mkLoc"]>>;
  beforeAll(async () => {
    org = await makeOrg();
    loc = await org.mkLoc(org.a);
  });
  const draft = (over: Draft = {}) =>
    run<{ post: Post }>(org.manager, "posts.createDraft", {
      workspaceId: org.a,
      locationIds: [loc.id],
      topicType: "STANDARD",
      summary: `Saturday hours ${tok()}.`,
      ...over,
    });

  it("a draft takes the workspace default (en until changed), or the language it is given", async () => {
    expect((await draft()).post.language).toBe("en");
    await db.update(workspaces).set({ defaultPostLanguage: "es" }).where(eq(workspaces.id, org.a));
    expect((await draft()).post.language).toBe("es");
    expect((await draft({ language: "fr" })).post.language).toBe("fr");
    const listed = await run<{ posts: Post[] }>(org.manager, "posts.list", { workspaceId: org.a });
    expect(new Set(listed.posts.map((p) => p.language))).toEqual(new Set(["en", "es", "fr"]));
  });

  it("updateDraft changes it; an unknown code is INVALID_INPUT", async () => {
    const { post } = await draft({ language: "en" });
    const up = await run<{ post: Post }>(org.manager, "posts.updateDraft", {
      id: post.id,
      language: "vi",
    });
    expect(up.post.language).toBe("vi");
    expect(
      await codeOf(run(org.manager, "posts.updateDraft", { id: post.id, language: "klingon" })),
    ).toBe("INVALID_INPUT");
    expect(await codeOf(draft({ language: "xx" }))).toBe("INVALID_INPUT");
  });

  it("reaches Google as languageCode", async () => {
    const id = await approvedPost(org, org.a, [loc.id], { language: "es" });
    await run(org.manager, "posts.schedule", { id });
    expect(await processPostSend(db, { postId: id, occurrence: 0 }, { client })).toBe("published");
    const sent = mock.calls.filter((c) => c.method === "createLocalPost").at(-1)!;
    expect((sent.args[1] as { languageCode?: string }).languageCode).toBe("es");
  });
});

describe("workspace default post language", () => {
  it("owners set it; managers and client roles cannot; another org gets NOT_FOUND; workspaces.list shows it", async () => {
    const org = await makeOrg();
    const other = await makeOrg();
    const set = (actor: Actor, workspaceId: string, language = "es") =>
      run<{ workspace: { id: string; defaultPostLanguage: string } }>(
        actor,
        "workspaces.setPostLanguage",
        { workspaceId, language },
      );
    expect((await set(org.owner, org.a)).workspace).toMatchObject({
      id: org.a,
      defaultPostLanguage: "es",
    });
    expect(await codeOf(set(org.manager, org.a, "fr"))).toBe("FORBIDDEN");
    expect(await codeOf(set(org.approverA, org.a, "fr"))).toBe("FORBIDDEN");
    expect(await codeOf(set(other.owner, org.a, "fr"))).toBe("NOT_FOUND");
    expect(await codeOf(set(org.owner, org.a, "xx"))).toBe("INVALID_INPUT");

    const listed = await run<{ workspaces: { id: string; defaultPostLanguage: string }[] }>(
      org.owner,
      "workspaces.list",
    );
    expect(listed.workspaces.find((w) => w.id === org.a)?.defaultPostLanguage).toBe("es");
    expect(listed.workspaces.find((w) => w.id === org.b)?.defaultPostLanguage).toBe("en");

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.orgId, org.orgId), eq(auditLog.action, "workspace.post_language_set")),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityId: org.a,
      before: { defaultPostLanguage: "en" },
      after: { defaultPostLanguage: "es" },
    });
  });
});

describe("sent back by", () => {
  it("a post sent back names who sent it back, in get and list; a fresh draft has none", async () => {
    const org = await makeOrg();
    const loc = await org.mkLoc(org.a);
    const { post } = await run<{ post: Post }>(org.manager, "posts.createDraft", {
      workspaceId: org.a,
      locationIds: [loc.id],
      topicType: "STANDARD",
      summary: `Saturday clinic ${tok()}.`,
    });
    expect(post.rejectedByName).toBeNull();
    await run(org.manager, "posts.submit", { id: post.id, acknowledgeWarnings: true });
    await db.update(users).set({ name: "Dr. Ramos" }).where(eq(users.id, org.approverA.userId));
    const sent = await run<{ post: Post & { rejectReason: string } }>(
      org.approverA,
      "posts.reject",
      {
        id: post.id,
        reason: "Wait until the Saturday hours are confirmed",
      },
    );
    expect(sent.post).toMatchObject({
      status: "draft",
      rejectReason: "Wait until the Saturday hours are confirmed",
      rejectedByName: "Dr. Ramos",
    });
    const listed = await run<{ posts: Post[] }>(org.manager, "posts.list", { workspaceId: org.a });
    expect(listed.posts.find((p) => p.id === post.id)?.rejectedByName).toBe("Dr. Ramos");
  });
});
