import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { locations, replyTemplates, type Tx } from "@opengmb/db";
import { AccessError, authorize, type Actor } from "../actor";
import { AI_DEFAULTS } from "../config/ai-models";
import { marketForTimeZone } from "../config/writing-style";
import { CoreError } from "../errors";
import { writeAudit } from "../audit";
import { AI_NOT_SET_UP, aiEnv, getAiModel } from "../ai/model";
import { draftOut, runDraft, type DraftResult } from "../ai/draft";
import { buildSystemPrompt, getBrandVoice } from "../ai/voice";
import { PRIVACY_LINE } from "../guardrails";
import { normalise } from "../guardrails/text";
import { defineAction, type ActionContext } from "../registry";
import { getReviewRow, type ReviewRow } from "../reviews/queries";
import { buildGuardrailContext } from "../reviews/reply-context";
import { reviewerFirstName } from "../reviews/templates";
import { decideApproval, getWorkspaceReplySettings } from "../reviews/workspace-settings";
import { workspaceTimeZone } from "./posts";
import { reviewRepliesCreateDraft, reviewRepliesSubmit } from "./reviewReplies";

/** How many of the client's own templates go into the prompt as style examples (the shortest ones). */
const TEMPLATE_EXAMPLES = 3;

const digits = (s: string) => s.replace(/\D/g, "");

/**
 * Google shows a translated review as "(Translated by Google) <English>\n\n(Original)\n<what they wrote>".
 * The reply goes in the language they wrote, so the prompt gets the original half.
 */
export function originalReviewText(comment: string): string {
  const i = comment.lastIndexOf("(Original)");
  return i < 0 ? comment : comment.slice(i + "(Original)".length).trim();
}

/** The model's draft for one review, through the same metering, caps and guardrails as ai.draftText. */
export async function draftForReview(
  ctx: { tx: Tx; actor: Actor; audit: ActionContext["audit"] },
  review: ReviewRow,
  language: string | undefined,
): Promise<DraftResult> {
  const { tx } = ctx;
  const rating = review.starRating;
  const settings = await getWorkspaceReplySettings(tx, review.workspaceId);
  const healthcare = settings.packs.includes("hipaa");
  const [loc] = await tx
    .select({ title: locations.title, name: locations.name, phone: locations.phone })
    .from(locations)
    .where(eq(locations.id, review.locationId));
  const locationName = loc?.title ?? loc?.name ?? review.locationName;

  const templates = (
    await tx
      .select({ body: replyTemplates.body, generic: replyTemplates.generic })
      .from(replyTemplates)
      .where(and(eq(replyTemplates.workspaceId, review.workspaceId)))
      .orderBy(asc(replyTemplates.name))
  )
    .filter((t) => !settings.genericTemplatesOnly || t.generic)
    .map((t) => t.body)
    .sort((a, b) => a.length - b.length)
    .slice(0, TEMPLATE_EXAMPLES);

  // Healthcare 1-3 star replies must carry the fixed privacy line and the card phone (guardrail H4).
  const privacy =
    healthcare && rating !== null && rating <= 3 ? { line: PRIVACY_LINE, phone: loc?.phone ?? null } : null;
  const voice = await getBrandVoice(tx, review.workspaceId);
  const system = buildSystemPrompt("reply", voice, {
    market: marketForTimeZone(await workspaceTimeZone(tx, review.workspaceId)),
    rating,
    // A healthcare client never names the reviewer (guardrail H2.reviewer).
    firstName: healthcare ? null : reviewerFirstName(review.reviewerDisplayName, review.reviewerIsAnonymous),
    ...(language ? { language } : {}),
    templates,
    privacy,
  });
  const text = originalReviewText(review.comment ?? "").slice(0, AI_DEFAULTS.maxSourceChars);
  const user = [
    "<source>",
    `Business: ${locationName}`,
    `Star rating: ${rating ?? "none"}${rating === null ? "" : " out of 5"}`,
    "Review text:",
    text.trim() === "" ? "(The reviewer left no written text.)" : text,
    "</source>",
  ].join("\n");

  return runDraft(ctx, {
    workspaceId: review.workspaceId,
    purpose: "reply",
    system,
    user,
    sourceChars: text.length,
    // The context the reply flow itself uses on submit: staff names, H4 phone, and the location's recent
    // replies, so R6.duplicate fires on a draft exactly as it would on a typed reply.
    async buildContext(body) {
      const built = await buildGuardrailContext(tx, { reviewId: review.id, body });
      if (!built) throw new AccessError("NOT_FOUND", "Review not found");
      return built.ctx;
    },
    finalize: privacy
      ? (body) => {
          let out = body;
          if (!normalise(out).includes(normalise(privacy.line))) out = `${out.trimEnd()} ${privacy.line}`;
          if (privacy.phone && !digits(out).includes(digits(privacy.phone))) {
            out = `${out.trimEnd()} Please call us on ${privacy.phone}.`;
          }
          return out;
        }
      : undefined,
  });
}

async function loadReview(tx: Tx, actor: Actor, id: string): Promise<ReviewRow> {
  const review = await getReviewRow(tx, actor, id);
  if (!review) throw new AccessError("NOT_FOUND", "Review not found");
  authorize(actor, "review:draft", { workspaceId: review.workspaceId });
  return review;
}

export const aiDraftReply = defineAction({
  name: "ai.draftReply",
  description:
    "Draft a reply to one review with AI. Reads the review itself (text, star rating, reviewer first name only, location, the client's brand voice and a few of its reply templates as style examples) and writes in the review's language unless the client's brand voice sets one (language is a hint you may pass). A 1-2 star review gets an apology and an offer to take it offline, with no admission of fault. The draft is metered, em dashes are replaced, and it runs through the same guardrails as a typed reply for this location (including the duplicate check against its recent replies). status 'ok' returns the draft text (warningRuleIds lists non-blocking findings, for example wording the writing style bans); status 'blocked' returns blockedRuleIds and NO text. Refused with AI_BUDGET_EXCEEDED over the monthly cap, NOT_CONFIGURED when this server has no AI key. Nothing is saved: put the text in reviewReplies.createDraft, then reviewReplies.submit. Needs review:draft (owner, admin, manager).",
  input: z.object({
    reviewId: z.uuid(),
    language: z.string().trim().max(40).optional(),
  }),
  output: draftOut,
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async preview(_ctx, input) {
    return {
      summary: `Draft a reply to review ${input.reviewId} with AI. Nothing is saved or published.`,
    };
  },
  async handler({ tx, actor, audit }, input) {
    const review = await loadReview(tx, actor, input.reviewId);
    if (!getAiModel(aiEnv())) throw new CoreError("NOT_CONFIGURED", AI_NOT_SET_UP);
    return draftForReview({ tx, actor, audit }, review, input.language);
  },
});

// --- bulk -----------------------------------------------------------------------------------------

const OUTCOMES = ["drafted", "blocked", "refused", "skipped", "failed", "not_attempted"] as const;
const itemOut = z.object({
  reviewId: z.string(),
  /**
   * drafted: saved and submitted (replyStatus says where it stands). blocked: a guardrail blocked the
   * draft, nothing saved (ruleIds). refused: over the monthly cap, the run stopped here. skipped: the
   * review already has a reply or draft (or is not yours to draft for). failed: the AI call failed
   * (reason). not_attempted: left untouched because the run stopped at a refusal.
   */
  outcome: z.enum(OUTCOMES),
  replyId: z.string().nullable(),
  replyStatus: z.string().nullable(),
  reason: z.string().nullable(),
  blockedRuleIds: z.array(z.string()),
  warningRuleIds: z.array(z.string()),
});
type Item = z.input<typeof itemOut>;

const SKIP_REASON: Record<string, string> = {
  replied: "It already has a reply.",
  not_wanted: "Replies are turned off for this review.",
};

/**
 * Save a finished AI draft as a reply revision and submit it, in a savepoint of its own: the model call
 * is already metered by the caller, and a failure saving or submitting undoes only the draft, never the
 * usage row. Shared by bulk drafting and draft-on-arrival, so both flow through the same approval rules.
 */
export async function saveAndSubmitDraft(ctx: ActionContext, review: ReviewRow, d: DraftResult): Promise<Item> {
  const reviewId = review.id;
  const base = { reviewId, replyId: null, replyStatus: null, reason: null, blockedRuleIds: [], warningRuleIds: [] };
  // Warnings are stored with the draft and a person sees them in approval. But when the client's
  // star rule would approve (and maybe publish) it, warnings are NOT acknowledged for the person:
  // the draft stays a draft until someone reads them.
  const settings = await getWorkspaceReplySettings(ctx.tx, review.workspaceId);
  const autoApproves = decideApproval(settings, review.starRating).autoApprove;
  try {
    return await ctx.tx.transaction(async (sp2) => {
      const save: ActionContext = { ...ctx, tx: sp2 };
      const { reply } = await reviewRepliesCreateDraft.handler(save, { reviewId, body: d.draft! });
      const sub = await reviewRepliesSubmit.handler(save, {
        id: reply.id,
        acknowledgeWarnings: !autoApproves,
      });
      if (sub.outcome === "blocked") {
        throw new CoreError("CONFLICT", "The draft could not be submitted (blocked).");
      }
      const held = sub.outcome === "needs_acknowledgement";
      return {
        ...base,
        outcome: "drafted" as const,
        replyId: reply.id,
        replyStatus: held ? "draft" : sub.outcome,
        warningRuleIds: d.warningRuleIds,
        ...(held
          ? { reason: "Saved as a draft: it has warnings a person must read before it can be submitted." }
          : {}),
      };
    });
  } catch (e) {
    if (e instanceof CoreError) return { ...base, outcome: "failed" as const, reason: e.message };
    throw e;
  }
}

export const aiDraftReplies = defineAction({
  name: "ai.draftReplies",
  description: `Draft replies with AI for up to ${AI_DEFAULTS.bulkDraftMax} reviews and put each into the approval queue. One AI call per review, one after another. For each review: drafted (saved and submitted; replyStatus pending_approval, or approved if the client's star rule approves it), blocked (a guardrail blocked the draft; blockedRuleIds; nothing saved), refused (over the monthly cap: the run stops there and the rest are not_attempted), skipped (the review already has a reply or a draft, or is not found or not allowed), failed (the AI call failed). Warnings (for example banned wording) do not stop a draft: they are stored on it and a person sees them in approval. If the client's star rule would auto-approve the draft, a draft with warnings stays a draft instead (replyStatus draft) until a person reads it. Each draft goes through the same metering, guardrails and audit as ai.draftReply. NOT_CONFIGURED when this server has no AI key. Needs review:draft (owner, admin, manager).`,
  input: z.object({
    reviewIds: z.array(z.uuid()).min(1).max(AI_DEFAULTS.bulkDraftMax),
  }),
  output: z.object({
    results: z.array(itemOut),
    counts: z.object({
      drafted: z.number().int(),
      blocked: z.number().int(),
      refused: z.number().int(),
      skipped: z.number().int(),
      failed: z.number().int(),
      notAttempted: z.number().int(),
    }),
    /** True when a monthly cap stopped the run before the last review. */
    stoppedOverCap: z.boolean(),
  }),
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async preview(_ctx, input) {
    return {
      summary: `Draft replies with AI for ${input.reviewIds.length} reviews and submit them for approval. Nothing is published.`,
    };
  },
  async handler(ctx, input) {
    const { actor, audit } = ctx;
    if (!getAiModel(aiEnv())) throw new CoreError("NOT_CONFIGURED", AI_NOT_SET_UP);
    const ids = [...new Set(input.reviewIds)];
    const results: Item[] = [];
    const item = (reviewId: string, outcome: Item["outcome"], extra: Partial<Item> = {}): Item => ({
      reviewId,
      outcome,
      replyId: null,
      replyStatus: null,
      reason: null,
      blockedRuleIds: [],
      warningRuleIds: [],
      ...extra,
    });
    let stopped: string | null = null;

    for (const reviewId of ids) {
      if (stopped) {
        results.push(item(reviewId, "not_attempted", { reason: stopped }));
        continue;
      }
      // Each review is its own transaction on a separate connection (ctx.db), committed as soon as it
      // finishes. The action's own transaction stays idle until the summary audit row, so a later
      // failure, a timeout or a closed browser never undoes drafts or metering already done, and the
      // platform AI lock (transaction level) is held for one call at a time.
      try {
        const out = await ctx.db.transaction(async (sp) => {
          const bind: ActionContext = {
            ...ctx,
            tx: sp,
            audit: async (entry) => {
              await writeAudit(sp, {
                ...entry,
                orgId: actor.orgId,
                actorUserId: actor.userId,
                actorType: actor.actorType,
                surface: actor.surface,
              });
            },
          };
          const inner = bind;
          const review = await getReviewRow(sp, actor, reviewId);
          if (!review) return item(reviewId, "skipped", { reason: "Review not found." });
          try {
            authorize(actor, "review:draft", { workspaceId: review.workspaceId });
          } catch {
            return item(reviewId, "skipped", { reason: "You can't draft replies for this client." });
          }
          if (review.replyStage !== "needs_reply") {
            return item(reviewId, "skipped", {
              reason: SKIP_REASON[review.replyStage] ?? "It already has a draft or a reply waiting.",
            });
          }
          const d = await draftForReview(inner, review, undefined);
          if (d.status === "blocked") {
            return item(reviewId, "blocked", {
              blockedRuleIds: d.blockedRuleIds,
              warningRuleIds: d.warningRuleIds,
              reason: "A guardrail blocked the draft.",
            });
          }
          return await saveAndSubmitDraft(bind, review, d);
        });
        results.push(out);
      } catch (e) {
        if (e instanceof AccessError && e.message.startsWith("AI_BUDGET_EXCEEDED")) {
          stopped = "Stopped: a monthly AI limit was reached before this review.";
          results.push(item(reviewId, "refused", { reason: e.message.replace("AI_BUDGET_EXCEEDED: ", "") }));
        } else {
          results.push(
            item(reviewId, "failed", {
              reason: e instanceof CoreError ? e.message : "Something went wrong drafting this review.",
            }),
          );
        }
      }
    }

    const count = (o: Item["outcome"]) => results.filter((r) => r.outcome === o).length;
    const counts = {
      drafted: count("drafted"),
      blocked: count("blocked"),
      refused: count("refused"),
      skipped: count("skipped"),
      failed: count("failed"),
      notAttempted: count("not_attempted"),
    };
    // Counts only: never review or reply text.
    await audit({
      action: "ai.draft_replies",
      entityType: "review",
      entityId: ids[0]!,
      after: { requested: ids.length, ...counts },
    });
    return { results, counts, stoppedOverCap: count("refused") > 0 };
  },
});
