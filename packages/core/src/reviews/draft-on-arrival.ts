import { aiEnabledForOrg } from "../ai/switch";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { reviewAutoDrafts, reviews, workspaceReplySettings, type Db, type Tx } from "@opengmb/db";
import { loadActor } from "../actor";
import { draftForReview, saveAndSubmitDraft } from "../actions/aiReplies";
import { writeAudit } from "../audit";
import { CreditExhaustedError, isReadOnlyAccount } from "../billing";
import { DRAFT_ON_ARRIVAL } from "../config/draft-on-arrival";
import { aiEnv, getAiModel } from "../ai/model";
import { CoreError } from "../errors";
import { enqueueJob } from "../jobs";
import { roleHasPermission } from "../permissions";
import type { ActionContext } from "../registry";
import { getReviewRow } from "./queries";
import type { ReviewChange, ReviewLocation } from "./upsert";
import { getWorkspaceReplySettings } from "./workspace-settings";

export const DRAFT_ARRIVAL_QUEUE = "reviews.draftOnArrival";
/** Queue options the worker creates `reviews.draftOnArrival` with. */
export const DRAFT_ARRIVAL_QUEUE_OPTIONS = {
  retryLimit: DRAFT_ON_ARRIVAL.retryLimit,
  retryDelay: 60,
  retryBackoff: true,
} as const;

const DAY_MS = 86_400_000;

export type ArrivalOutcome =
  | "drafted" // saved and submitted (approval, or approved under the client's star rule)
  | "held" // saved as a draft: it has warnings and the star rule would have approved it
  | "blocked" // a guardrail blocked the text; nothing saved
  | "skipped_not_needed" // the review got a reply or draft first, or replies are off for it
  | "skipped_no_credit" // out of credit, read-only account, or a monthly AI limit
  | "skipped_ai_unavailable" // this server has no AI key
  | "skipped_no_actor" // the person who switched it on no longer may draft here
  | "failed"; // saving the draft failed; nothing saved

/**
 * Called inside the sync transaction after the upsert: queue one draft job per NEW, unreplied review, so the
 * jobs exist if and only if the sync commits and the AI call never runs inside it. Nothing is queued for a
 * location's first sync (an import is not news), for a workspace that has the setting off, or past the per
 * sync cap (newest first). Returns how many were queued.
 */
export async function enqueueArrivalDrafts(
  tx: Tx,
  loc: ReviewLocation,
  changes: ReviewChange[],
  opts: { firstSync: boolean; now?: Date },
): Promise<number> {
  if (opts.firstSync) return 0;
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - DRAFT_ON_ARRIVAL.maxAgeDays * DAY_MS;
  const fresh = changes.filter((c) => c.wasInserted && c.createTime.getTime() >= cutoff);
  if (fresh.length === 0) return 0;

  const [row] = await tx
    .select({ on: workspaceReplySettings.draftOnArrival, by: workspaceReplySettings.draftOnArrivalBy })
    .from(workspaceReplySettings)
    .where(eq(workspaceReplySettings.workspaceId, loc.workspaceId));
  if (!row?.on || !row.by) return 0;
  const settings = await getWorkspaceReplySettings(tx, loc.workspaceId);

  const candidates = await tx
    .select({ id: reviews.id, rating: reviews.starRating })
    .from(reviews)
    .where(and(inArray(reviews.id, fresh.map((c) => c.reviewId)), isNull(reviews.replyComment)))
    .orderBy(desc(reviews.createTime));
  const wanted = candidates
    .filter((r) => !(settings.skipPositiveReviews && r.rating !== null && r.rating >= 4))
    .slice(0, DRAFT_ON_ARRIVAL.maxPerSync);
  for (const r of wanted) await enqueueJob(tx, DRAFT_ARRIVAL_QUEUE, { reviewId: r.id });
  if (wanted.length > 0) {
    await writeAudit(tx, {
      orgId: loc.orgId,
      actorUserId: null,
      actorType: "system",
      surface: "worker",
      action: "review_draft.arrival_queued",
      entityType: "location",
      entityId: loc.id,
      after: { queued: wanted.length, newReviews: fresh.length, cap: DRAFT_ON_ARRIVAL.maxPerSync },
    });
  }
  return wanted.length;
}

export type ArrivalResult = ArrivalOutcome | "duplicate" | "off" | "gone";

/**
 * Worker side of `reviews.draftOnArrival`: one review, one transaction. The claim row in review_auto_drafts is
 * the idempotency guard: a retried or duplicated job finds it and does nothing. A skip or a block keeps the
 * claim (and says why); a thrown error (the AI call failed) rolls the claim back so pg-boss can retry.
 * Acts as the person who switched the setting on, through the same draft and submit path as bulk drafting, so
 * the client's star rule, guardrails, approval queue and auto-publish settings all apply as for a manual draft.
 */
export async function processArrivalDraft(db: Db, reviewId: string): Promise<ArrivalResult> {
  return db.transaction(async (tx) => {
    const [r] = await tx
      .select({ id: reviews.id, orgId: reviews.orgId, workspaceId: reviews.workspaceId })
      .from(reviews)
      .where(eq(reviews.id, reviewId));
    if (!r) return "gone" as const;
    const [cfg] = await tx
      .select({ on: workspaceReplySettings.draftOnArrival, by: workspaceReplySettings.draftOnArrivalBy })
      .from(workspaceReplySettings)
      .where(eq(workspaceReplySettings.workspaceId, r.workspaceId));
    if (!cfg?.on || !cfg.by) return "off" as const;

    const [claim] = await tx
      .insert(reviewAutoDrafts)
      .values({ reviewId, orgId: r.orgId, workspaceId: r.workspaceId, outcome: "pending" })
      .onConflictDoNothing()
      .returning({ reviewId: reviewAutoDrafts.reviewId });
    if (!claim) return "duplicate" as const;

    const finish = async (outcome: ArrivalOutcome, replyId: string | null = null, extra: object = {}) => {
      await tx.update(reviewAutoDrafts).set({ outcome, replyId }).where(eq(reviewAutoDrafts.reviewId, reviewId));
      await writeAudit(tx, {
        orgId: r.orgId,
        actorUserId: null,
        actorType: "system",
        surface: "worker",
        action: "review_draft.arrival",
        entityType: "review",
        entityId: reviewId,
        after: { outcome, replyId, ...extra }, // outcome and ids only; never review or reply text
      });
      return outcome;
    };

    let actor;
    try {
      actor = await loadActor(db, { userId: cfg.by, orgId: r.orgId, surface: "worker", actorType: "system" });
    } catch {
      return finish("skipped_no_actor");
    }
    // The person who switched it on must still hold review:draft for this client (removed or demoted: it stops).
    const review = roleHasPermission(actor.role, "review:draft") ? await getReviewRow(tx, actor, reviewId) : null;
    if (!review) return finish("skipped_no_actor");
    if (review.replyStage !== "needs_reply") return finish("skipped_not_needed");
    if (!getAiModel(aiEnv())) return finish("skipped_ai_unavailable");
    if (!(await aiEnabledForOrg(tx, r.orgId))) return finish("skipped_ai_unavailable", null, { reason: "account_switch_off" });
    // A read-only account (ended trial, lapsed plan) gets no new AI spend. System actors are exempt from the
    // executor's read-only gate so syncs keep working, which is why this job checks it itself.
    if (await isReadOnlyAccount(tx, r.orgId, new Date(), aiEnv())) {
      return finish("skipped_no_credit", null, { reason: "read_only" });
    }

    const ctx: ActionContext = {
      tx,
      db,
      actor,
      audit: async (entry) => {
        await writeAudit(tx, { ...entry, orgId: r.orgId, actorUserId: null, actorType: "system", surface: "worker" });
      },
      afterCommit: () => {},
    };
    // The AI call sits in a savepoint so a credit or cap refusal (thrown before the model is called) keeps the claim.
    let d;
    try {
      d = await tx.transaction((sp) => draftForReview({ ...ctx, tx: sp }, review, undefined));
    } catch (e) {
      if (e instanceof CreditExhaustedError) return finish("skipped_no_credit", null, { reason: "credit" });
      if (e instanceof CoreError && e.message.startsWith("AI_BUDGET_EXCEEDED")) {
        return finish("skipped_no_credit", null, { reason: "monthly_limit" });
      }
      throw e;
    }
    if (d.status === "blocked") return finish("blocked", null, { blockedRuleIds: d.blockedRuleIds });
    const item = await saveAndSubmitDraft(ctx, review, d);
    if (item.outcome === "failed") return finish("failed", null, { reason: item.reason });
    return finish(item.replyStatus === "draft" ? "held" : "drafted", item.replyId, { replyStatus: item.replyStatus });
  });
}
