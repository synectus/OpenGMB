import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  aiUsage,
  auditLog,
  createDb,
  replyTemplates,
  reviewReplies,
  reviews,
  workspaceReplySettings,
  workspaces,
} from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit, uniq, type Org } from "./testkit";
import { setAiTestOverrides, type AiModel } from "./ai/model";
import { PRIVACY_LINE } from "./guardrails";
import { ensureQueues } from "./jobs";
import { REPLY_PUBLISH_QUEUE } from "./reviews/reply-jobs";
import { originalReviewText } from "./actions/aiReplies";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: pg } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
const { run } = kit;

let org: Org;
let other: Org;
let loc: Awaited<ReturnType<Org["mkLoc"]>>;
beforeAll(async () => {
  await ensureQueues(url, [REPLY_PUBLISH_QUEUE]); // a fresh test database has no pg-boss schema
  org = await kit.makeOrg();
  other = await kit.makeOrg();
  loc = await org.mkLoc(org.a);
});
afterAll(async () => {
  setAiTestOverrides({});
  vi.unstubAllGlobals();
  await kit.deactivateAll();
  await pg.end();
});

const CANARY_OUT = "ZQXCANARYOUTPUT";
const calls: { system: string; user: string }[] = [];
/** A fake model: answers by call index (the last answer repeats), records what it was sent. */
const fake =
  (answers: string[], tokens: { i: number; o: number } = { i: 100, o: 50 }): AiModel =>
  async (req) => {
    calls.push({ system: req.system, user: req.user });
    const text = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return { text, inputTokens: tokens.i, outputTokens: tokens.o };
  };
const useModel = (m: AiModel, cap = "1000") =>
  setAiTestOverrides({ model: m, env: { AI_MONTHLY_BUDGET_USD: cap } });

let seq = 0;
async function mkReview(
  o: { rating?: number | null; comment?: string | null; name?: string | null; reply?: string; locationId?: string; workspaceId?: string } = {},
) {
  const now = new Date();
  const [r] = await db
    .insert(reviews)
    .values({
      orgId: org.orgId,
      workspaceId: o.workspaceId ?? org.a,
      locationId: o.locationId ?? loc.row.id,
      googleReviewName: `${loc.parent}/reviews/${uniq()}-${seq++}`,
      reviewerDisplayName: o.name === undefined ? "Pat Reviewer" : o.name,
      starRating: o.rating === undefined ? 5 : o.rating,
      comment: o.comment === undefined ? "Friendly team and a short wait." : o.comment,
      createTime: now,
      updateTime: now,
      ...(o.reply ? { replyComment: o.reply, replyUpdateTime: now } : {}),
    })
    .returning();
  return r!;
}

type Draft = { status: string; draft: string | null; blockedRuleIds: string[]; warningRuleIds: string[] };
const draftReply = (reviewId: string, extra: Record<string, unknown> = {}, actor = org.manager) =>
  run<Draft>(actor, "ai.draftReply", { reviewId, ...extra });
type Bulk = {
  results: { reviewId: string; outcome: string; replyId: string | null; replyStatus: string | null; reason: string | null; blockedRuleIds: string[]; warningRuleIds: string[] }[];
  counts: Record<string, number>;
  stoppedOverCap: boolean;
};
const bulk = (reviewIds: string[], actor = org.manager) => run<Bulk>(actor, "ai.draftReplies", { reviewIds });
const repliesFor = (ids: string[]) => db.select().from(reviewReplies).where(inArray(reviewReplies.reviewId, ids));

beforeEach(async () => {
  await run(org.owner, "aiUsage.setClientCap", { workspaceId: org.a, monthlyCapUsd: null });
  calls.length = 0;
  vi.stubGlobal("fetch", () => {
    throw new Error("the real network must never be reached in tests");
  });
});

describe("original text of a translated review", () => {
  it("takes the half after (Original)", () => {
    expect(originalReviewText("(Translated by Google) Great service\n\n(Original)\nMuy buen servicio")).toBe("Muy buen servicio");
    expect(originalReviewText("Plain review")).toBe("Plain review");
  });
});

describe("ai.draftReply", () => {
  it("sends the review, rating and first name only; removes em dashes; audits no text", async () => {
    useModel(fake([`Thanks for coming in — the team will read this. ${CANARY_OUT}`]));
    const r = await mkReview({ rating: 5, comment: "Friendly team and a short wait.", name: "Pat Reviewer" });
    const d = await draftReply(r.id);
    expect(d.status).toBe("ok");
    expect(d.draft).not.toContain("—");
    expect(d.draft).toContain("Thanks for coming in, the team will read this.");
    const { system, user } = calls[0]!;
    expect(user).toContain("Friendly team and a short wait.");
    expect(user).toContain("5 out of 5");
    expect(user).toContain(loc.row.name);
    expect(system).toContain("first name only: Pat");
    expect(system + user).not.toContain("Reviewer"); // the surname never leaves
    const all = JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.orgId, org.orgId)));
    expect(all).not.toContain(CANARY_OUT);
    expect(all).not.toContain("short wait");
  });

  it("an anonymous reviewer is not addressed by name", async () => {
    useModel(fake(["Thank you for the review."]));
    const r = await mkReview({ name: "A Google User" });
    await draftReply(r.id);
    expect(calls[0]!.system).toContain("Do not address the reviewer by name");
  });

  it("a banned word comes back as a warning on the draft, not a block", async () => {
    useModel(fake(["We aim for a seamless visit and we are glad it showed."]));
    const d = await draftReply((await mkReview()).id);
    expect(d.status).toBe("ok");
    expect(d.warningRuleIds).toContain("U8.style");
    expect(d.draft).toContain("seamless");
  });

  it("a 1-2 star review is told to apologise and take it offline without admitting fault", async () => {
    useModel(fake(["We are sorry about this. Please contact us directly so we can talk it through."]));
    await draftReply((await mkReview({ rating: 1, comment: "Rude and slow." })).id);
    const sys = calls[0]!.system;
    expect(sys).toContain("1 star review");
    expect(sys).toContain("offline");
    expect(sys).toContain("Do not admit fault or liability");
    expect(sys).toContain("do not mention any health or medical detail");
  });

  it("passes the language through, and the client's brand voice language wins", async () => {
    useModel(fake(["Gracias por su opinion."]));
    const r = await mkReview({ comment: "Muy buen servicio." });
    await draftReply(r.id);
    expect(calls[0]!.system).toContain("Write in the same language as the review");
    await draftReply(r.id, { language: "Spanish" });
    expect(calls[1]!.system).toContain("Write in this language: Spanish.");
    expect(calls[1]!.user).toContain("Muy buen servicio.");
    await run(org.manager, "aiVoice.update", { workspaceId: org.a, language: "French" });
    await draftReply(r.id, { language: "Spanish" });
    expect(calls[2]!.system).toContain("Write in this language: French.");
    expect(calls[2]!.system).not.toContain("Spanish");
    await run(org.manager, "aiVoice.update", { workspaceId: org.a, language: "" });
  });

  it("uses the client's templates as examples, the three shortest first", async () => {
    const mk = (name: string, body: string) =>
      db.insert(replyTemplates).values({ orgId: org.orgId, workspaceId: org.a, name, body, generic: true, createdBy: org.ownerId });
    await mk("long", "This is a much longer template body that goes on for a while to make it the longest one here.");
    await mk("t3", "Template three, a little longer.");
    await mk("t1", "Short one.");
    await mk("t2", "Template two, medium.");
    useModel(fake(["Thanks."]));
    await draftReply((await mkReview()).id);
    const sys = calls[0]!.system;
    expect(sys).toContain("- Short one.");
    expect(sys).toContain("- Template two, medium.");
    expect(sys).toContain("- Template three, a little longer.");
    expect(sys).not.toContain("much longer template body");
    expect(sys.indexOf("Short one.")).toBeLessThan(sys.indexOf("Template two"));
    await db.delete(replyTemplates).where(eq(replyTemplates.workspaceId, org.a));
  });

  it("R6.duplicate fires on a draft equal to a recent reply at the location", async () => {
    const same = "Thanks for the kind review, we will pass it on to the whole crew.";
    await mkReview({ reply: same });
    useModel(fake([same]));
    const d = await draftReply((await mkReview()).id);
    expect(d.status).toBe("blocked");
    expect(d.blockedRuleIds).toContain("R6.duplicate");
    expect(d.draft).toBeNull();
  });

  it("healthcare 1-3 star: the privacy line and phone are added so H4 passes, and no name is sent", async () => {
    const hc = await org.mkLoc(org.b);
    await db.insert(workspaceReplySettings).values({ orgId: org.orgId, workspaceId: org.b, profile: "healthcare", packs: ["hipaa"] });
    useModel(fake(["We are sorry to hear this and would like to put it right."]));
    const r = await mkReview({ workspaceId: org.b, locationId: hc.row.id, rating: 2, comment: "Waited too long." });
    const d = await draftReply(r.id);
    expect(d.status).toBe("ok");
    expect(d.draft).toContain(PRIVACY_LINE);
    expect(d.draft).toContain("555 010 0199");
    expect(calls[0]!.system).toContain("Do not address the reviewer by name");
    expect(calls[0]!.system).toContain(PRIVACY_LINE);
  });

  it("picks the market from the workspace time zone", async () => {
    useModel(fake(["Thanks."]));
    const r = await mkReview();
    await db.update(workspaces).set({ timeZone: "Australia/Melbourne" }).where(eq(workspaces.id, org.a));
    await draftReply(r.id);
    expect(calls[0]!.system).toContain("Market: Australia");
    await db.update(workspaces).set({ timeZone: "Asia/Kolkata" }).where(eq(workspaces.id, org.a));
    await draftReply(r.id);
    expect(calls[1]!.system).toContain("Market: India");
    await db.update(workspaces).set({ timeZone: "UTC" }).where(eq(workspaces.id, org.a));
    await draftReply(r.id);
    expect(calls[2]!.system).toContain("Market: United States");
  });

  it("permissions and scope", async () => {
    useModel(fake(["Thanks."]));
    const r = await mkReview();
    expect(await codeOf(draftReply(r.id, {}, org.viewerA))).toMatch(/^FORBIDDEN/);
    expect(await codeOf(draftReply(r.id, {}, other.manager))).toMatch(/^NOT_FOUND/);
    setAiTestOverrides({ env: {} });
    expect(await codeOf(draftReply(r.id))).toMatch(/^NOT_CONFIGURED/);
  });
});

describe("ai.draftReplies (bulk)", () => {
  it("10 reviews give 10 drafts in approval, each with a stored guardrail result", async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => mkReview({ rating: 4, comment: `Review number ${i}` })));
    useModel(fake(rs.map((_, i) => `Thank you for review ${i}. See you again soon.`)));
    const out = await bulk(rs.map((r) => r.id));
    expect(out.counts).toMatchObject({ drafted: 10, blocked: 0, refused: 0, skipped: 0, failed: 0, notAttempted: 0 });
    expect(out.results.every((r) => r.outcome === "drafted" && r.replyStatus === "pending_approval")).toBe(true);
    expect(calls).toHaveLength(10); // one model call per review
    const rows = await repliesFor(rs.map((r) => r.id));
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.status).toBe("pending_approval");
      const g = row.guardrailResult as { ok: boolean; packs: string[] } | null;
      expect(g, "every draft carries its guardrail result").not.toBeNull();
      expect(g!.ok).toBe(true);
      expect(g!.packs).toContain("universal");
    }
    console.log(`bulk: ${out.counts.drafted}/10 drafted, ${rows.length} replies in approval, ${calls.length} model calls`);
  });

  it("a guardrail block saves nothing and names the rules; a warning goes to approval with the warning stored", async () => {
    const [a, b, c] = await Promise.all([mkReview(), mkReview(), mkReview()]);
    useModel(fake(["Visit https://spam.example.test today.", "A seamless visit, thanks for writing.", "Thanks for writing."]));
    const out = await bulk([a!.id, b!.id, c!.id]);
    expect(out.results.map((r) => r.outcome)).toEqual(["blocked", "drafted", "drafted"]);
    expect(out.results[0]!.blockedRuleIds).toContain("U7.url");
    expect(await repliesFor([a!.id])).toHaveLength(0);
    const [rb] = await repliesFor([b!.id]);
    expect(rb!.status).toBe("pending_approval");
    expect(rb!.warningsAcknowledged).toBe(true);
    expect(JSON.stringify(rb!.guardrailResult)).toContain("U8.style");
    expect(out.results[1]!.warningRuleIds).toContain("U8.style");
  });

  it("skips reviews that already have a reply or a draft, without calling the model for them", async () => {
    const fresh = await mkReview();
    const replied = await mkReview({ reply: "We already answered this one on Google." });
    const drafted = await mkReview();
    await run(org.manager, "reviewReplies.createDraft", { reviewId: drafted.id, body: "A person is already writing this." });
    useModel(fake(["Thanks for writing."]));
    const out = await bulk([fresh.id, replied.id, drafted.id]);
    expect(out.results.map((r) => r.outcome)).toEqual(["drafted", "skipped", "skipped"]);
    expect(out.results[1]!.reason).toMatch(/already has a reply/);
    expect(out.results[2]!.reason).toMatch(/draft/);
    expect(calls).toHaveLength(1);
    expect((await repliesFor([drafted.id]))[0]!.body).toBe("A person is already writing this.");
  });

  it("a cap refusal mid-run stops the rest with a clear result", async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => mkReview()));
    // Each call costs about 300_010 micro-USD (the pre-call check adds a few hundred). Cap 0.45 USD:
    // call 1 and 2 pass (0 and 300_010 spent), call 3 sees 600_020 spent and is refused.
    await run(org.owner, "aiUsage.setClientCap", { workspaceId: org.a, monthlyCapUsd: 0.45 });
    const m = vi.fn(fake(["Thanks for writing."], { i: 100, o: 600_000 }));
    useModel(m);
    const out = await bulk(rs.map((r) => r.id));
    expect(out.results.map((r) => r.outcome)).toEqual(["drafted", "drafted", "refused", "not_attempted", "not_attempted"]);
    expect(out.stoppedOverCap).toBe(true);
    expect(out.results[2]!.reason).toMatch(/monthly AI limit/);
    expect(out.results[3]!.reason).toMatch(/Stopped/);
    expect(m).toHaveBeenCalledTimes(2);
    expect(await repliesFor(rs.map((r) => r.id))).toHaveLength(2);
    expect(out.counts).toMatchObject({ drafted: 2, refused: 1, notAttempted: 2 });
  });

  it("every call is metered, and nothing in the audit log holds review or reply text", async () => {
    const rs = await Promise.all([mkReview({ comment: "ZQXREVIEWTEXT one" }), mkReview({ comment: "ZQXREVIEWTEXT two" })]);
    useModel(fake([`Thanks one. ${CANARY_OUT}`, `Thanks two. ${CANARY_OUT}`]));
    const before = (await db.select().from(aiUsage).where(eq(aiUsage.workspaceId, org.a))).length;
    await bulk(rs.map((r) => r.id));
    expect((await db.select().from(aiUsage).where(eq(aiUsage.workspaceId, org.a))).length).toBe(before + 2);
    const all = JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.orgId, org.orgId)));
    expect(all).not.toContain(CANARY_OUT);
    expect(all).not.toContain("ZQXREVIEWTEXT");
    expect(JSON.stringify(await kit.auditRows(org.orgId, "ai.draft_replies"))).toContain('"drafted":2');
  });

  it("with an auto-approve rule, a draft that has warnings stays a draft and nothing is queued to publish", async () => {
    await db.insert(workspaceReplySettings).values({ orgId: org.orgId, workspaceId: org.a, autoApproveMinStars: 4, autoPublish: true }).onConflictDoUpdate({
      target: workspaceReplySettings.workspaceId, set: { autoApproveMinStars: 4, autoPublish: true },
    });
    const [warned, clean] = await Promise.all([mkReview({ rating: 5 }), mkReview({ rating: 5 })]);
    useModel(fake(["A seamless visit, thanks for writing.", "Thanks for writing, see you soon."]));
    const out = await bulk([warned!.id, clean!.id]);
    expect(out.results[0]).toMatchObject({ outcome: "drafted", replyStatus: "draft" });
    expect(out.results[0]!.reason).toMatch(/warnings/);
    expect(out.results[1]).toMatchObject({ outcome: "drafted", replyStatus: "approved" }); // the rule still works for clean text
    const [rw] = await repliesFor([warned!.id]);
    expect(rw!.status).toBe("draft");
    expect(rw!.approvedAt).toBeNull();
    expect(rw!.publishRequestedAt).toBeNull();
    await db.update(workspaceReplySettings).set({ autoApproveMinStars: null, autoPublish: false }).where(eq(workspaceReplySettings.workspaceId, org.a));
  });

  it("a failure on review 3 of 5 leaves reviews 1 and 2 drafted and metered (each review commits on its own)", async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => mkReview()));
    let n = 0;
    useModel(async (req) => {
      calls.push({ system: req.system, user: req.user });
      if (++n === 3) throw new Error("boom");
      return { text: `Thanks for writing, number ${n}.`, inputTokens: 100, outputTokens: 50 };
    });
    const before = (await db.select().from(aiUsage).where(eq(aiUsage.workspaceId, org.a))).length;
    const out = await bulk(rs.map((r) => r.id));
    expect(out.results.map((r) => r.outcome)).toEqual(["drafted", "drafted", "failed", "drafted", "drafted"]);
    expect(out.results[2]!.reason).not.toContain("boom");
    const rows = await repliesFor(rs.map((r) => r.id));
    expect(rows.map((r) => r.reviewId).sort()).toEqual([rs[0]!.id, rs[1]!.id, rs[3]!.id, rs[4]!.id].sort());
    expect((await db.select().from(aiUsage).where(eq(aiUsage.workspaceId, org.a))).length).toBe(before + 4);
  });

  it("reviews of another organization are skipped as not found; viewers are refused", async () => {
    const mine = await mkReview();
    useModel(fake(["Thanks for writing."]));
    const out = await bulk([mine.id, "00000000-0000-4000-8000-000000000001"]);
    expect(out.results.map((r) => r.outcome)).toEqual(["drafted", "skipped"]);
    expect(await codeOf(bulk([mine.id], org.viewerA))).toMatch(/^FORBIDDEN/);
    expect(await codeOf(run(org.manager, "ai.draftReplies", { reviewIds: [] }))).toMatch(/INVALID_INPUT/);
  });
});
