import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  aiUsage,
  createDb,
  organizations,
  reviewReplies,
  reviews,
  workspaceReplySettings,
} from "@opengmb/db";
import { setAiTestOverrides, type AiModel } from "./ai/model";
import { MockGoogleClient } from "./google/mock-client";
import { processReviewSync, REVIEW_SYNC_QUEUE } from "./reviews/sync";
import { REPLY_PUBLISH_QUEUE } from "./reviews/reply-jobs";
import { codeOf, makeKit, uniq, type Org } from "./testkit";

// ON2: the one free first reply draft, started only by a click. Hosted-only cases (balance, read-only) are in firstDraft.private.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: pg } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const { run } = kit;
const boss = new PgBoss(url);

beforeAll(async () => {
  await boss.start();
  for (const q of [REVIEW_SYNC_QUEUE, REPLY_PUBLISH_QUEUE]) await boss.createQueue(q);
});
afterAll(async () => {
  await boss.stop();
  setAiTestOverrides({});
  vi.unstubAllGlobals();
  await kit.deactivateAll();
  await pg.end();
});

const TEXT = "Thank you for the kind words. We hope to see you again soon.";
let modelCalls = 0;
let answer = TEXT;
const fake: AiModel = async () => {
  modelCalls++;
  return { text: answer, inputTokens: 100, outputTokens: 50 };
};
const useModel = (cap = "1000") => setAiTestOverrides({ model: fake, env: { AI_MONTHLY_BUDGET_USD: cap } });

beforeEach(() => {
  modelCalls = 0;
  answer = TEXT;
  useModel();
  vi.stubGlobal("fetch", () => {
    throw new Error("the real network must never be reached in tests");
  });
});

type First = { reviewId: string; replyId: string | null; outcome: "drafted" | "blocked" };
type State = { firstDraft: { used: boolean; reviewId: string | null; replyStatus: string | null; aiReady: boolean } };
/** The web click goes through the one-time AI notice first; so does anyone calling over MCP. */
const click = async (o: Org, actor = o.owner) => {
  await run(actor, "aiNotice.acknowledge", {});
  return run<First>(actor, "onboarding.firstDraft", {});
};
const clickRaw = (o: Org, actor = o.owner) => run<First>(actor, "onboarding.firstDraft", {});
const state = (o: Org) => run<State>(o.owner, "onboarding.get", {}).then((s) => s.firstDraft);
const column = async (o: Org) =>
  (await db.select({ c: organizations.firstDraftReviewId }).from(organizations).where(eq(organizations.id, o.orgId)))[0]!.c;
const usageRows = (o: Org) => db.select().from(aiUsage).where(eq(aiUsage.orgId, o.orgId));
const repliesOf = (ids: string[]) => db.select().from(reviewReplies).where(inArray(reviewReplies.reviewId, ids));

let seq = 0;
/** A review straight into the table, so its age and reply are exact. */
async function mkReview(
  o: Org,
  loc: Awaited<ReturnType<Org["mkLoc"]>>,
  p: { ageDays: number; reply?: boolean; rating?: number; workspaceId?: string },
) {
  const t = new Date(Date.now() - p.ageDays * 86_400_000);
  const [r] = await db
    .insert(reviews)
    .values({
      orgId: o.orgId,
      workspaceId: p.workspaceId ?? o.a,
      locationId: loc.row.id,
      googleReviewName: `${loc.parent}/reviews/${uniq()}-${seq++}`,
      reviewerDisplayName: "Pat Reviewer",
      starRating: p.rating ?? 4,
      comment: "Friendly team and a short wait.",
      createTime: t,
      updateTime: t,
      ...(p.reply ? { replyComment: "Thanks!", replyUpdateTime: t } : {}),
    })
    .returning();
  return r!.id;
}

/** replied (newest), needs a reply (middle, two years old), needs a reply (oldest). */
async function mkCase() {
  const o = await kit.makeOrg();
  const l = await o.mkLoc(o.a);
  const replied = await mkReview(o, l, { ageDays: 1, reply: true });
  const middle = await mkReview(o, l, { ageDays: 730 });
  const oldest = await mkReview(o, l, { ageDays: 1500 });
  return { o, l, replied, middle, oldest };
}

describe("onboarding.firstDraft", () => {
  it("1. the import's first sync makes no AI call and claims nothing; the click makes exactly one (canary)", async () => {
    const o = await kit.makeOrg();
    const l = await o.mkLoc(o.a);
    mock.addReview(l.row.googleAccountName!, l.row.googleLocationId!, { starRating: "TWO", comment: "Waited a long time." });
    const out = (await run(o.owner, "reviews.sync", { workspaceId: o.a, locationIds: [l.row.id] })) as { syncs: { syncId: string }[] };
    await processReviewSync(db, out.syncs[0]!.syncId, { client: mock });
    expect(await db.select().from(reviews).where(eq(reviews.locationId, l.row.id))).not.toHaveLength(0);
    expect(modelCalls).toBe(0);
    expect(await usageRows(o)).toHaveLength(0);
    expect(await column(o)).toBeNull();
    expect((await state(o)).used).toBe(false);
    expect(modelCalls).toBe(0); // reading the state is not a click

    await click(o);
    expect(modelCalls).toBe(1);
  });

  it("2. happy path, any age: drafts the newest review that needs a reply, saved as a draft", async () => {
    const c = await mkCase();
    const r = await click(c.o);
    expect(r).toMatchObject({ reviewId: c.middle, outcome: "drafted" });
    const [reply] = await repliesOf([c.middle]);
    expect(reply!.id).toBe(r.replyId);
    expect(reply!.status).toBe("draft");
    expect(JSON.stringify(reply)).toContain(TEXT);
    expect(await column(c.o)).toBe(c.middle);
    expect(await repliesOf([c.replied, c.oldest])).toHaveLength(0);
    expect(await state(c.o)).toMatchObject({ used: true, reviewId: c.middle, replyStatus: "draft" });
    const audit = await kit.auditRows(c.o.orgId, "onboarding.firstDraft");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("Friendly team");
  });

  it("3. one ai_usage row counts toward the platform limit (the balance is checked in the private test)", async () => {
    const c = await mkCase();
    await click(c.o);
    expect(await usageRows(c.o)).toHaveLength(1);
  });

  it("4. draft only: a client auto-approve rule does not submit it", async () => {
    const c = await mkCase();
    await run(c.o.owner, "workspaceSettings.update", { workspaceId: c.o.a, autoApproveMinStars: 4 });
    expect((await db.select().from(workspaceReplySettings).where(eq(workspaceReplySettings.workspaceId, c.o.a)))[0]!.autoApproveMinStars).toBe(4);
    await click(c.o);
    const [reply] = await repliesOf([c.middle]);
    expect(reply!.status).toBe("draft");
  });

  it("5. once per account, also for another location; no second AI call", async () => {
    const c = await mkCase();
    await click(c.o);
    expect(modelCalls).toBe(1);
    const l2 = await c.o.mkLoc(c.o.a);
    await mkReview(c.o, l2, { ageDays: 2 });
    expect(await codeOf(click(c.o))).toBe("CONFLICT");
    await expect(click(c.o)).rejects.toThrow(/already used/);
    expect(modelCalls).toBe(1);
  });

  it("6. AI switched off: refused, no model call, the claim is rolled back", async () => {
    const c = await mkCase();
    await db.update(organizations).set({ aiDisabledAt: new Date() }).where(eq(organizations.id, c.o.orgId));
    expect(await codeOf(click(c.o))).not.toBe("no error");
    expect(modelCalls).toBe(0);
    expect(await column(c.o)).toBeNull();
    expect((await state(c.o)).aiReady).toBe(false);
    await db.update(organizations).set({ aiDisabledAt: null }).where(eq(organizations.id, c.o.orgId));
    expect((await state(c.o)).aiReady).toBe(true);
    await click(c.o); // can try again once AI is back on
    expect(modelCalls).toBe(1);
  });

  it("7. monthly limit reached: AI_BUDGET_EXCEEDED, claim rolled back", async () => {
    const c = await mkCase();
    useModel("0");
    await expect(click(c.o)).rejects.toThrow(/AI_BUDGET_EXCEEDED/);
    expect(modelCalls).toBe(0);
    expect(await column(c.o)).toBeNull();
  });

  it("9. a guardrail blocks the text: outcome blocked, no reply, the free draft is used up", async () => {
    const c = await mkCase();
    answer = ""; // an empty draft is blocked (U.empty)
    const r = await click(c.o);
    expect(r).toMatchObject({ outcome: "blocked", replyId: null, reviewId: c.middle });
    expect(await repliesOf([c.middle])).toHaveLength(0);
    expect(await usageRows(c.o)).toHaveLength(1);
    expect(await column(c.o)).toBe(c.middle);
    expect(await state(c.o)).toMatchObject({ used: true, reviewId: c.middle, replyStatus: null });
  });

  it("10. no review needs a reply: NOT_FOUND, claim stays null", async () => {
    const o = await kit.makeOrg();
    const l = await o.mkLoc(o.a);
    await mkReview(o, l, { ageDays: 3, reply: true });
    expect(await state(o)).toMatchObject({ used: false, reviewId: null });
    expect(await codeOf(click(o))).toBe("NOT_FOUND");
    expect(modelCalls).toBe(0);
    expect(await column(o)).toBeNull();
  });

  it("11. a client_viewer cannot draft", async () => {
    const c = await mkCase();
    expect(await codeOf(click(c.o, c.o.viewerA))).toBe("FORBIDDEN");
    expect(modelCalls).toBe(0);
    expect(await column(c.o)).toBeNull();
  });

  it("12. refused until the person has acknowledged the AI notice: no claim, no model call, no ai_usage row; allowed after", async () => {
    const c = await mkCase();
    await expect(clickRaw(c.o)).rejects.toThrow(/acknowledge the AI notice/i);
    expect(modelCalls).toBe(0);
    expect(await column(c.o)).toBeNull();
    expect(await usageRows(c.o)).toHaveLength(0);
    expect((await clickRaw(c.o, c.o.owner).catch(() => null))).toBeNull(); // still refused
    await run(c.o.owner, "aiNotice.acknowledge", {});
    expect((await clickRaw(c.o)).outcome).toBe("drafted");
    expect(modelCalls).toBe(1);
  });

  it("13. a member limited to another client gets no review id or status for the stored first draft", async () => {
    const c = await mkCase(); // the review is in workspace A
    await click(c.o);
    expect(await state(c.o)).toMatchObject({ used: true, reviewId: c.middle, replyStatus: "draft" });
    const own = (await run<State>(c.o.approverA, "onboarding.get", {})).firstDraft;
    expect(own.reviewId).toBe(c.middle);
    const other = (await run<State>(c.o.approverB, "onboarding.get", {})).firstDraft;
    expect(other).toMatchObject({ used: true, reviewId: null, replyStatus: null });
  });

  it("5b. before the click the state offers the newest review that needs a reply, with the AI ready", async () => {
    const c = await mkCase();
    expect(await state(c.o)).toEqual({ used: false, reviewId: c.middle, replyStatus: null, aiReady: true });
    expect(modelCalls).toBe(0);
    expect(await usageRows(c.o)).toHaveLength(0);
  });

  it("5c. replyStatus follows the latest reply after the draft is submitted", async () => {
    const c = await mkCase();
    const r = await click(c.o);
    await run(c.o.owner, "reviewReplies.submit", { id: r.replyId!, acknowledgeWarnings: true });
    const s = await state(c.o);
    expect(s.used).toBe(true);
    expect(s.replyStatus).not.toBe("draft");
    expect(s.replyStatus).not.toBeNull();
  });
});
