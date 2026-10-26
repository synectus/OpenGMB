import { and, desc, eq, ne } from "drizzle-orm";
import { googleConnections, locations, reviewReplies, reviews, type Db, type Tx } from "@opengmb/db";
import {
  GoogleApiError,
  GoogleRateLimitError,
  GoogleRetriesExhaustedError,
  GoogleWritesDisabledError,
} from "../google/errors";
import { isOrgBlocked } from "../account-state";
import { createGoogleClient } from "../google/factory";
import { assertPassed, runGuardrails, type GuardrailResult } from "../guardrails";
import { deferBlockedJob } from "../jobs";
import { publishReply, removeGoogleReply, type ReplyWriter } from "./publish";
import { buildGuardrailContext } from "./reply-context";
import { transitionReply, workerAudit, type ReplyRow } from "./reply-state";

/** Whitespace-insensitive comparison key for reply text. */
const normaliseReply = (text: string) => text.trim().replace(/\s+/g, " ");

type GoogleReply = { comment: string; updateTime: string } | null;

/**
 * What the live Google review says about our reply, relative to the revision's base snapshot:
 *   already_applied  Google's reply already equals our body (a retry after Google applied our
 *                    write): mark published, send nothing.
 *   conflict         Google's reply differs from the base we drafted against (changed, added or
 *                    deleted in the Google UI): refuse, send nothing.
 *   clear            Google still shows exactly the base: safe to publish.
 */
type GoogleCheck =
  | { kind: "already_applied"; google: NonNullable<GoogleReply> }
  | { kind: "conflict"; google: GoogleReply }
  | { kind: "clear" };

export function compareWithGoogle(
  reply: Pick<ReplyRow, "body" | "baseReplyComment" | "baseReplyUpdateTime">,
  google: GoogleReply,
): GoogleCheck {
  if (google && normaliseReply(google.comment) === normaliseReply(reply.body)) {
    return { kind: "already_applied", google };
  }
  const sameComment = (google?.comment ?? null) === reply.baseReplyComment;
  const googleTime = google ? new Date(google.updateTime).getTime() : null;
  const baseTime = reply.baseReplyUpdateTime?.getTime() ?? null;
  return sameComment && googleTime === baseTime ? { kind: "clear" } : { kind: "conflict", google };
}

export const REPLY_PUBLISH_QUEUE = "reviewReplies.publish";
export const REPLY_DELETE_QUEUE = "reviewReplies.deleteGoogleReply";
/**
 * Queue options for both reply queues. Google errors are classified inside the job (a 4xx fails
 * the reply, no retry); pg-boss retries only unexpected errors such as a database failure.
 */
export const REPLY_QUEUE_OPTIONS = { retryLimit: 3, retryDelay: 30, retryBackoff: true } as const;

/** Why a Google call failed, as stored on the reply; null for errors we do not classify (retried). */
export function googleFailure(e: unknown): string | null {
  if (e instanceof GoogleApiError) return `google_http_${e.status}`;
  if (e instanceof GoogleRetriesExhaustedError || e instanceof GoogleRateLimitError) {
    return "google_rate_limited";
  }
  if (e instanceof GoogleWritesDisabledError) return "google_writes_disabled";
  return null;
}

type Target = {
  orgId: string;
  locationActive: boolean;
  reviewName: string;
  connectionId: string | null;
  linked: boolean;
};

async function loadTarget(tx: Tx, reviewId: string): Promise<Target | null> {
  const [row] = await tx
    .select({
      orgId: reviews.orgId,
      reviewName: reviews.googleReviewName,
      status: locations.status,
      connectionId: locations.connectionId,
      account: locations.googleAccountName,
      loc: locations.googleLocationId,
    })
    .from(reviews)
    .innerJoin(locations, eq(locations.id, reviews.locationId))
    .where(eq(reviews.id, reviewId));
  if (!row) return null;
  return {
    orgId: row.orgId,
    locationActive: row.status === "active",
    reviewName: row.reviewName,
    connectionId: row.connectionId,
    linked: Boolean(row.account && row.loc),
  };
}

export async function clientFor(db: Db, orgId: string, connectionId: string | null) {
  if (!connectionId) return null;
  const [conn] = await db
    .select()
    .from(googleConnections)
    .where(and(eq(googleConnections.id, connectionId), eq(googleConnections.orgId, orgId)));
  return conn ? createGoogleClient({ db, connection: conn }) : null;
}

const requestedBy = (r: ReplyRow) => ({ requestedBy: r.publishRequestedBy });

/** What Phase 1 decided: an end status, "already on Google" (settle), or go on to publish. */
type PublishPlan =
  | { end: ReplyRow["status"] }
  | { settle: { comment: string; updateTime: string } }
  | { reply: ReplyRow; target: Target; passed: ReturnType<typeof assertPassed> };

/** End an `approved` reply as `failed` in its own short transaction (no-op if it already moved on). */
function failReply(db: Db, replyId: string, reason: string) {
  return db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(reviewReplies)
      .where(eq(reviewReplies.id, replyId))
      .for("update");
    if (!cur || cur.status !== "approved") return cur?.status ?? null;
    return (
      await transitionReply(tx, {
        reply: cur,
        to: "failed",
        action: "failed",
        set: { failureReason: reason },
        audit: workerAudit(tx, cur.orgId),
        extra: { ...requestedBy(cur), failureReason: reason },
      })
    ).status;
  });
}

/**
 * Phase 3: one short transaction. `published`, Google's reply copied onto the review, the previous
 * published revision `superseded`.
 */
function settlePublished(
  db: Db,
  replyId: string,
  sent: { comment: string; updateTime: string },
  passed: ReturnType<typeof assertPassed> | null,
) {
  return db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(reviewReplies)
      .where(eq(reviewReplies.id, replyId))
      .for("update");
    if (!cur || cur.status !== "approved") return cur?.status ?? null;
    const audit = workerAudit(tx, cur.orgId);
    const previous = await tx
      .select()
      .from(reviewReplies)
      .where(
        and(
          eq(reviewReplies.reviewId, cur.reviewId),
          eq(reviewReplies.status, "published"),
          ne(reviewReplies.id, cur.id),
        ),
      );
    for (const prev of previous) {
      await transitionReply(tx, {
        reply: prev,
        to: "superseded",
        action: "superseded",
        audit,
        extra: { supersededBy: cur.id },
      });
    }
    const row = await transitionReply(tx, {
      reply: cur,
      to: "published",
      action: "published",
      set: {
        publishedAt: new Date(),
        failureReason: null,
        ...(passed ? { guardrailResult: passed.result } : {}),
      },
      audit,
      ...(passed ? { guardrail: passed.result } : {}),
      extra: passed ? requestedBy(cur) : { ...requestedBy(cur), alreadyOnGoogle: true },
    });
    await tx
      .update(reviews)
      .set({ replyComment: sent.comment, replyUpdateTime: new Date(sent.updateTime) })
      .where(eq(reviews.id, cur.reviewId));
    return row.status;
  });
}

/**
 * Worker side of `reviewReplies.publish`. Nothing is sent unless the reply is still `approved`
 * with a publish request.
 *
 * Phase 0 (no transaction): re-fetch the review from Google (`getReview`) and compare its reply
 * with the base snapshot taken when the revision was created (`compareWithGoogle`). Google already
 * showing our exact text means a retry after Google applied our write: the reply is marked
 * `published` and nothing is sent. Google's reply differing from the base (changed, added or
 * deleted in the Google UI) ends the reply `conflict`: Google's current reply is recorded on the
 * reply, copied onto the review, and nothing is written to Google. A getReview failure is handled
 * like a failed write (4xx/429 fail the reply, other errors retry).
 * Phase 1 (one short transaction, no Google): rebuild the guardrail
 * context and run the guardrails AGAIN, because rules, settings or the location's other replies
 * may have changed since submit; a block ends the reply `blocked`, unacknowledged warnings end it
 * `failed` (publish again with acknowledgeWarnings). Phase 2 (no transaction): `publishReply`,
 * which needs the branded `GuardrailPassed`. Phase 3: `settlePublished`.
 * The window between Phase 0 and the write cannot be closed (Google has no conditional update);
 * it is seconds, versus the hours or days between draft and publish that the check covers.
 *
 * A Google 4xx (not 429) fails the reply with no retry; 429 and 5xx are retried inside the
 * throttled client and fail the reply once exhausted. Any other error is thrown so pg-boss
 * retries; on the final attempt it fails the reply. Re-running a settled reply does nothing, and
 * the idempotency key `reply:<replyId>` stops a re-run after a crash from sending twice.
 */
export async function processReplyPublish(
  db: Db,
  replyId: string,
  deps: { client?: ReplyWriter; isFinalAttempt?: boolean } = {},
): Promise<ReplyRow["status"] | null> {
  // Phase 0
  const pre = await db.transaction(async (tx) => {
    const [reply] = await tx.select().from(reviewReplies).where(eq(reviewReplies.id, replyId));
    if (!reply || reply.status !== "approved" || !reply.publishRequestedAt) return null;
    // AP3b: suspended or deleted. The reply stays `approved` and asked-for; the job is re-queued for later.
    if (await isOrgBlocked(tx, reply.orgId)) {
      await deferBlockedJob(tx, REPLY_PUBLISH_QUEUE, { replyId }, reply.orgId);
      return null;
    }
    return { reply, target: await loadTarget(tx, reply.reviewId) };
  });
  if (!pre) return null;
  // Target problems (missing review, inactive location, not linked) are failed in Phase 1.
  const checkable = pre.target?.locationActive && pre.target.linked ? pre.target : null;
  const client = checkable
    ? (deps.client ?? (await clientFor(db, checkable.orgId, checkable.connectionId)))
    : null;
  let check: GoogleCheck | null = null;
  if (checkable && client) {
    try {
      const g = await client.getReview(checkable.reviewName);
      check = compareWithGoogle(
        pre.reply,
        g.reviewReply?.comment
          ? { comment: g.reviewReply.comment, updateTime: g.reviewReply.updateTime }
          : null,
      );
    } catch (e) {
      const reason = googleFailure(e);
      if (reason) return failReply(db, replyId, reason);
      if (deps.isFinalAttempt) await failReply(db, replyId, "unexpected_error");
      throw e;
    }
  }

  // Phase 1
  const verdict: GoogleCheck | null = check;
  const plan = await db.transaction(async (tx): Promise<PublishPlan | null> => {
    const [reply] = await tx
      .select()
      .from(reviewReplies)
      .where(eq(reviewReplies.id, replyId))
      .for("update");
    if (!reply || reply.status !== "approved" || !reply.publishRequestedAt) return null;
    if (await isOrgBlocked(tx, reply.orgId)) {
      await deferBlockedJob(tx, REPLY_PUBLISH_QUEUE, { replyId }, reply.orgId);
      return null;
    }
    const audit = workerAudit(tx, reply.orgId);
    const fail = async (reason: string, guardrail?: GuardrailResult) =>
      ({
        end: (
          await transitionReply(tx, {
            reply,
            to: "failed",
            action: "failed",
            set: { failureReason: reason, ...(guardrail ? { guardrailResult: guardrail } : {}) },
            audit,
            guardrail,
            extra: { ...requestedBy(reply), failureReason: reason },
          })
        ).status,
      }) as const;

    const target = await loadTarget(tx, reply.reviewId);
    if (!target) return fail("review_missing");
    if (!target.locationActive) return fail("location_inactive");
    if (!target.linked) return fail("location_not_linked_to_google");

    if (verdict?.kind === "conflict") {
      const g = verdict.google;
      const row = await transitionReply(tx, {
        reply,
        to: "conflict",
        action: "conflict",
        set: {
          conflictGoogleComment: g?.comment ?? null,
          conflictGoogleUpdateTime: g ? new Date(g.updateTime) : null,
          conflictDetectedAt: new Date(),
          publishRequestedBy: null,
          publishRequestedAt: null,
          warningsAcknowledged: false,
        },
        audit,
        // ids and flags only: neither our text nor Google's reply goes into the audit row
        extra: {
          ...requestedBy(reply),
          googleReplyPresent: g !== null,
          baseReplyPresent: reply.baseReplyComment !== null,
        },
      });
      await tx
        .update(reviews)
        .set({
          replyComment: g?.comment ?? null,
          replyUpdateTime: g ? new Date(g.updateTime) : null,
        })
        .where(eq(reviews.id, reply.reviewId));
      return { end: row.status } as const;
    }
    if (verdict?.kind === "already_applied") return { settle: verdict.google } as const;

    const built = await buildGuardrailContext(tx, { reviewId: reply.reviewId, body: reply.body });
    if (!built) return fail("review_missing");
    const result = runGuardrails(built.ctx);
    if (!result.ok) {
      const row = await transitionReply(tx, {
        reply,
        to: "blocked",
        action: "blocked",
        set: {
          guardrailResult: result,
          publishRequestedBy: null,
          publishRequestedAt: null,
          warningsAcknowledged: false,
        },
        audit,
        guardrail: result,
        extra: { ...requestedBy(reply), stage: "publish" },
      });
      return { end: row.status } as const;
    }
    if (result.violations.length > 0 && !reply.warningsAcknowledged) {
      return fail("warnings_require_acknowledgement", result);
    }
    return { reply, target, passed: assertPassed(result, reply.body) } as const;
  });
  if (!plan) return null;
  if ("end" in plan) return plan.end;
  if ("settle" in plan) return settlePublished(db, replyId, plan.settle, null);

  const { reply, target, passed } = plan;
  if (!client) return failReply(db, reply.id, "connection_removed");

  // Phase 2: Google, no transaction open.
  let sent: { comment: string; updateTime: string };
  try {
    sent = await publishReply(
      client,
      { orgId: target.orgId, replyId: reply.id, reviewName: target.reviewName },
      passed,
    );
  } catch (e) {
    const reason = googleFailure(e);
    if (reason) return failReply(db, reply.id, reason);
    if (deps.isFinalAttempt) {
      await failReply(db, reply.id, "unexpected_error");
    }
    throw e;
  }

  return settlePublished(db, reply.id, sent, passed);
}

export type ReplyDeleteJob = { reviewId: string; requestedBy: string };

/**
 * Worker side of `reviewReplies.deleteGoogleReply`: removes the Google reply, then in one short
 * transaction clears `reviews.reply_comment` and marks the published revision `deleted`. A reply
 * made in the Google UI has no revision; its idempotency token is built from its update time.
 * A review that already has no reply is a no-op; Google 404 counts as already deleted; other
 * Google errors are audited as `review_reply.delete_failed` and not retried.
 */
export async function processReplyDelete(
  db: Db,
  job: ReplyDeleteJob,
  deps: { client?: ReplyWriter; isFinalAttempt?: boolean } = {},
): Promise<"deleted" | "noop" | "failed"> {
  const plan = await db.transaction(async (tx) => {
    const [review] = await tx
      .select({
        replyComment: reviews.replyComment,
        replyUpdateTime: reviews.replyUpdateTime,
      })
      .from(reviews)
      .where(eq(reviews.id, job.reviewId));
    const target = await loadTarget(tx, job.reviewId);
    if (!review || !target || review.replyComment === null) return null;
    // AP3b: suspended or deleted. The Google reply stays; the job is re-queued for later.
    if (await isOrgBlocked(tx, target.orgId)) {
      await deferBlockedJob(tx, REPLY_DELETE_QUEUE, job, target.orgId);
      return "blocked" as const;
    }
    const [published] = await tx
      .select({ id: reviewReplies.id })
      .from(reviewReplies)
      .where(and(eq(reviewReplies.reviewId, job.reviewId), eq(reviewReplies.status, "published")))
      .orderBy(desc(reviewReplies.revision))
      .limit(1);
    return {
      target,
      publishedId: published?.id ?? null,
      token: published?.id ?? `ext-${review.replyUpdateTime?.getTime() ?? 0}`,
    };
  });
  if (!plan || plan === "blocked") return "noop";
  const { target } = plan;

  const recordFailure = async (reason: string) => {
    await db.transaction(async (tx) => {
      await workerAudit(
        tx,
        target.orgId,
      )({
        action: "review_reply.delete_failed",
        entityType: plan.publishedId ? "review_reply" : "review",
        entityId: plan.publishedId ?? job.reviewId,
        before: { status: "published" },
        after: { reviewId: job.reviewId, failureReason: reason, requestedBy: job.requestedBy },
      });
    });
    return "failed" as const;
  };
  if (!target.locationActive) return recordFailure("location_inactive");
  const client = deps.client ?? (await clientFor(db, target.orgId, target.connectionId));
  if (!client) return recordFailure("connection_removed");

  try {
    await removeGoogleReply(client, {
      orgId: target.orgId,
      reviewId: job.reviewId,
      reviewName: target.reviewName,
      publishedReplyId: plan.token,
    });
  } catch (e) {
    if (!(e instanceof GoogleApiError && e.status === 404)) {
      const reason = googleFailure(e);
      if (reason) return recordFailure(reason);
      if (deps.isFinalAttempt) await recordFailure("unexpected_error");
      throw e;
    }
  }

  await db.transaction(async (tx) => {
    const audit = workerAudit(tx, target.orgId);
    await tx
      .update(reviews)
      .set({ replyComment: null, replyUpdateTime: null })
      .where(eq(reviews.id, job.reviewId));
    const [pub] = plan.publishedId
      ? await tx
          .select()
          .from(reviewReplies)
          .where(and(eq(reviewReplies.id, plan.publishedId), eq(reviewReplies.status, "published")))
          .for("update")
      : [];
    if (pub) {
      await transitionReply(tx, {
        reply: pub,
        to: "deleted",
        action: "deleted",
        audit,
        extra: { requestedBy: job.requestedBy },
      });
    } else {
      await audit({
        action: "review_reply.deleted",
        entityType: "review",
        entityId: job.reviewId,
        before: { status: "published_external" },
        after: { status: "deleted", reviewId: job.reviewId, requestedBy: job.requestedBy },
      });
    }
  });
  return "deleted";
}
