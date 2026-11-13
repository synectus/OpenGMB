import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { organizations, reviewReplies, users } from "@opengmb/db";
import { authorize } from "../actor";
import { aiEnabledForOrg } from "../ai/switch";
import { aiEnv, getAiModel } from "../ai/model";
import { CoreError } from "../errors";
import { defineAction } from "../registry";
import { newestReviewNeedingReply } from "../reviews/first-draft";
import { getReviewRow } from "../reviews/queries";
import { draftForReview, loadReview } from "./aiReplies";
import { reviewRepliesCreateDraft } from "./reviewReplies";

export const onboardingGet = defineAction({
  name: "onboarding.get",
  description:
    "Whether the first-run checklist facts stored on the organization are set: healthReportSeen (someone opened a location's health report) and dismissed (an owner or admin hid the checklist). firstDraft is the state of the one free first reply draft (onboarding.firstDraft): used, the review it is for (the newest one that needs a reply while unused), replyStatus (the latest reply on that review, null before the click or after a guardrail blocked it) and aiReady (an AI key is set and the account's AI switch is on). Reading it never calls the AI.",
  input: z.object({}),
  output: z.object({
    healthReportSeen: z.boolean(),
    dismissed: z.boolean(),
    firstDraft: z.object({
      used: z.boolean(),
      reviewId: z.string().nullable(),
      replyStatus: z.string().nullable(),
      aiReady: z.boolean(),
    }),
  }),
  permission: "location:read",
  kind: "read",
  async handler({ tx, actor }) {
    const [o] = await tx
      .select({ seen: organizations.healthReportSeenAt, dismissed: organizations.setupDismissedAt, first: organizations.firstDraftReviewId })
      .from(organizations)
      .where(eq(organizations.id, actor.orgId));
    const used = o?.first != null;
    // A stored review id is only handed to someone who can see that review (a member limited to other clients gets none).
    const stored = used && o!.first && (await getReviewRow(tx, actor, o!.first)) ? o!.first : null;
    const reviewId = used ? stored : await newestReviewNeedingReply(tx, actor);
    let replyStatus: string | null = null;
    if (used && reviewId) {
      const [r] = await tx
        .select({ status: reviewReplies.status })
        .from(reviewReplies)
        .where(eq(reviewReplies.reviewId, reviewId))
        .orderBy(desc(reviewReplies.revision))
        .limit(1);
      replyStatus = r?.status ?? null;
    }
    const aiReady = getAiModel(aiEnv()) !== null && (await aiEnabledForOrg(tx, actor.orgId));
    return {
      healthReportSeen: o?.seen != null,
      dismissed: o?.dismissed != null,
      firstDraft: { used, reviewId: reviewId ?? null, replyStatus, aiReady },
    };
  },
});

export const onboardingUpdate = defineAction({
  name: "onboarding.update",
  description:
    "Keep the first-run checklist on Home honest. healthReportSeen true records that someone opened a location's health report (it stays on). dismissed true hides the checklist for the whole organization, false brings it back; dismissing needs google:manage (owner, admin). Pass only the fields to change. Writes nothing to Google.",
  input: z.object({ healthReportSeen: z.literal(true).optional(), dismissed: z.boolean().optional() }),
  output: z.object({ healthReportSeen: z.boolean(), dismissed: z.boolean() }),
  permission: "location:manage",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    if (input.dismissed !== undefined) authorize(actor, "google:manage");
    const [before] = await tx
      .select({ seen: organizations.healthReportSeenAt, dismissed: organizations.setupDismissedAt })
      .from(organizations)
      .where(eq(organizations.id, actor.orgId));
    const now = new Date();
    const patch: Partial<typeof organizations.$inferInsert> = {};
    if (input.healthReportSeen && !before?.seen) patch.healthReportSeenAt = now;
    if (input.dismissed !== undefined && (input.dismissed !== (before?.dismissed != null)))
      patch.setupDismissedAt = input.dismissed ? now : null;
    if (Object.keys(patch).length > 0)
      await tx.update(organizations).set(patch).where(eq(organizations.id, actor.orgId));
    const after = {
      healthReportSeen: patch.healthReportSeenAt !== undefined || before?.seen != null,
      dismissed: "setupDismissedAt" in patch ? patch.setupDismissedAt !== null : before?.dismissed != null,
    };
    await audit({
      action: "onboarding.update",
      entityType: "organization",
      entityId: actor.orgId,
      before: { healthReportSeen: before?.seen != null, dismissed: before?.dismissed != null },
      after,
    });
    return after;
  },
});

export const onboardingFirstDraft = defineAction({
  name: "onboarding.firstDraft",
  description:
    "The free first reply draft, once per organization. Drafts a reply with AI to the newest review that needs one and saves it as a DRAFT: it is never submitted, approved or published, and nothing goes to Google. The platform pays; nothing is taken from the account's credit. Sends that review's text to the AI provider, so call it only when the person asks. Refused with CONFLICT when the free draft was already used, NOT_FOUND when no review needs a reply, AI_BUDGET_EXCEEDED over the monthly AI limit, NOT_CONFIGURED without an AI key. outcome 'blocked' means a guardrail stopped the draft and nothing was saved (the free draft is then used). Needs review:draft, and the person must have acknowledged the one-time AI notice (aiNotice.acknowledge) first, else CONFLICT.",
  input: z.object({}),
  output: z.object({ reviewId: z.string(), replyId: z.string().nullable(), outcome: z.enum(["drafted", "blocked"]) }),
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async handler(ctx) {
    const { tx, actor, audit } = ctx;
    const reviewId = await newestReviewNeedingReply(tx, actor);
    if (!reviewId) throw new CoreError("NOT_FOUND", "No review is waiting for a reply.");
    if (!getAiModel(aiEnv())) throw new CoreError("NOT_CONFIGURED", "AI is not set up on this server");
    // The one-time AI notice is checked here too, so an MCP caller cannot send review text to the AI before a person has seen it.
    const [u] = await tx.select({ seen: users.aiNoticeSeenAt }).from(users).where(eq(users.id, actor.userId));
    if (!u?.seen) throw new CoreError("CONFLICT", "Acknowledge the AI notice first (aiNotice.acknowledge), then try again.");
    // Claim first: a second click waits on this row lock, then finds the column set. An error below rolls the claim back.
    const claimed = await tx
      .update(organizations)
      .set({ firstDraftReviewId: reviewId })
      .where(and(eq(organizations.id, actor.orgId), isNull(organizations.firstDraftReviewId)))
      .returning({ id: organizations.id });
    if (claimed.length === 0) throw new CoreError("CONFLICT", "The free first draft was already used.");
    const review = await loadReview(tx, actor, reviewId);
    const d = await draftForReview({ tx, actor, audit }, review, undefined, { waiveCharge: true });
    let replyId: string | null = null;
    // Saved, NOT submitted: no auto-approve or auto-publish rule can send text nobody has read.
    if (d.status !== "blocked") replyId = (await reviewRepliesCreateDraft.handler(ctx, { reviewId, body: d.draft! })).reply.id;
    const outcome = replyId ? ("drafted" as const) : ("blocked" as const);
    await audit({ action: "onboarding.firstDraft", entityType: "review", entityId: reviewId, after: { replyId, outcome } }); // ids only, never text
    return { reviewId, replyId, outcome };
  },
});
