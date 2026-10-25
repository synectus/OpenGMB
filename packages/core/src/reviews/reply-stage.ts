import { sql, type SQL } from "drizzle-orm";
import { reviewReplies, reviews, workspaceReplySettings } from "@opengmb/db";

/**
 * The one definition of where a review stands on its reply. Home's "needs attention", the location
 * Overview, Health, the Reviews filter and the CSV export all read this; none keeps its own rule.
 *
 * First match wins:
 *   1. the review's open revision is approved        -> waiting_publish  (nothing for a person to do)
 *      pending_approval                              -> waiting_approval (an approver's job)
 *      failed                                        -> failed
 *   2. Google shows a visible reply                  -> replied
 *      (a comment that Google did not REJECT)
 *   3. the workspace skips positive reviews, 4-5 stars -> not_wanted
 *   4. open revision draft                           -> draft
 *      blocked                                       -> blocked
 *   5. otherwise                                     -> needs_reply
 *
 * "Needs you" is needs_reply, draft, blocked and failed. An approved reply that is not published
 * yet (for example because GOOGLE_BUSINESS_WRITES is off) is NOT needs-you: it is waiting_publish.
 */
export const REPLY_STAGES = [
  "needs_reply",
  "draft",
  "blocked",
  "failed",
  "waiting_approval",
  "waiting_publish",
  "replied",
  "not_wanted",
] as const;
export type ReplyStage = (typeof REPLY_STAGES)[number];

export const NEEDS_YOU_STAGES = ["needs_reply", "draft", "blocked", "failed"] as const;
/** Needs-you, except `failed`: Home counts failed publishes in its own Failed bucket. */
export const TO_ANSWER_STAGES = ["needs_reply", "draft", "blocked"] as const;

/** Statuses of the review's single open revision (mirrors OPEN_STATUSES in reply-state.ts). */
export type OpenReplyStatus = "draft" | "pending_approval" | "approved" | "blocked" | "failed";

export type ReplyStageInput = {
  replyComment: string | null;
  replyState: string | null;
  starRating: number | null;
  openStatus: OpenReplyStatus | null;
  skipPositiveReviews: boolean;
};

/** JS twin of `replyStageSql`, for rows already loaded. reply-stage.test.ts pins the two together. */
export function replyStageOf(i: ReplyStageInput): ReplyStage {
  if (i.openStatus === "approved") return "waiting_publish";
  if (i.openStatus === "pending_approval") return "waiting_approval";
  if (i.openStatus === "failed") return "failed";
  if (i.replyComment !== null && i.replyState !== "REJECTED") return "replied";
  if (i.skipPositiveReviews && i.starRating !== null && i.starRating >= 4) return "not_wanted";
  if (i.openStatus === "draft") return "draft";
  if (i.openStatus === "blocked") return "blocked";
  return "needs_reply";
}

/** No reply is visible on Google (none, or one Google REJECTED). A Google fact, not a to-do. */
export const noVisibleReply = sql`(${reviews.replyComment} is null or coalesce(${reviews.replyState}, '') = 'REJECTED')`;
export const rowHasNoVisibleReply = (r: { replyComment: string | null; replyState: string | null }) =>
  r.replyComment === null || r.replyState === "REJECTED";

const openStatus = sql`(select ${reviewReplies.status}::text from ${reviewReplies} where ${reviewReplies.reviewId} = ${reviews.id} and ${reviewReplies.status} in ('draft', 'pending_approval', 'approved', 'blocked', 'failed') limit 1)`;
const skipsPositive = sql`(exists (select 1 from ${workspaceReplySettings} where ${workspaceReplySettings.workspaceId} = ${reviews.workspaceId} and ${workspaceReplySettings.skipPositiveReviews}) and ${reviews.starRating} >= 4)`;

/**
 * SQL twin of `replyStageOf`, for a query that already has the review's open revision status in hand
 * (`open`, text or null: a join to the one open reply row). Counting queries use it so the open reply is
 * looked up once per review, not once per `when`.
 */
export const stageSqlWithOpen = (open: SQL) => sql<ReplyStage>`(case
  when ${open} = 'approved' then 'waiting_publish'
  when ${open} = 'pending_approval' then 'waiting_approval'
  when ${open} = 'failed' then 'failed'
  when not ${noVisibleReply} then 'replied'
  when ${skipsPositive} then 'not_wanted'
  when ${open} = 'draft' then 'draft'
  when ${open} = 'blocked' then 'blocked'
  else 'needs_reply' end)`;

/** SQL twin of `replyStageOf`. Needs `reviews` in the query. */
export const replyStageSql = stageSqlWithOpen(openStatus);

/** The statuses of an open revision, as the one-open-per-review index counts them. */
export const OPEN_REPLY_STATUSES = ["draft", "pending_approval", "approved", "blocked", "failed"] as const;

/** `stage` (replyStageSql, or stageSqlWithOpen(...)) is one of `stages`. */
export const stageIn = (stage: SQL, stages: readonly ReplyStage[]) =>
  sql`(${stage} in (${sql.join(stages.map((s) => sql`${s}`), sql`, `)}))`;
const inStages = (stages: readonly ReplyStage[]) => stageIn(replyStageSql, stages);

/** Reviews a person has to act on: write, finish, fix or retry a reply. */
export const needsYouSql = inStages(NEEDS_YOU_STAGES);
/** Needs-you minus failed publishes (Home's reviews bucket; its Failed bucket counts the rest). */
export const toAnswerSql = inStages(TO_ANSWER_STAGES);
/** A submitted reply an approver has to decide on: the reply part of the one approvals count. */
export const waitingApprovalSql = inStages(["waiting_approval"]);
/** Approved, not yet on Google. */
export const waitingToPublishSql = inStages(["waiting_publish"]);

export const rowNeedsYou = (stage: ReplyStage) => (NEEDS_YOU_STAGES as readonly ReplyStage[]).includes(stage);
