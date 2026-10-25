import type { GuardrailPassed } from "../guardrails";
import type { ThrottledGoogleClient } from "../google/throttled-client";

/**
 * The ONLY place outside the Google client implementations that writes a reply to Google. A test
 * (`reply-enforcement.test.ts`) fails if any other source file calls `.updateReply(` or
 * `.deleteReply(`. `publishReply` takes a `GuardrailPassed`, which only `assertPassed` can build
 * from a `runGuardrails` result for exactly this text, so no caller can publish unchecked text.
 */
export type ReplyWriter = Pick<ThrottledGoogleClient, "updateReply" | "deleteReply" | "getReview">;

/** Idempotency key for publishing a reply revision: a re-run returns the stored response. */
export const publishKey = (replyId: string) => `reply:${replyId}`;

/** Idempotency key for deleting the Google reply that `publishedReplyId` published. */
export const deleteKey = (reviewId: string, publishedReplyId: string) =>
  `delete:${reviewId}:${publishedReplyId}`;

/** Send `passed.reply` as the reply to `reviewName`. Returns what Google stored. */
export function publishReply(
  client: ReplyWriter,
  p: { orgId: string; replyId: string; reviewName: string },
  passed: GuardrailPassed,
): Promise<{ comment: string; updateTime: string }> {
  return client.updateReply(p.reviewName, passed.reply, {
    orgId: p.orgId,
    idempotencyKey: publishKey(p.replyId),
  });
}

/**
 * Remove the Google reply on `reviewName`. Needs no GuardrailPassed (no text is sent).
 * `publishedReplyId` is the revision being removed, or an `ext-...` token when the reply was made
 * in the Google UI.
 */
export function removeGoogleReply(
  client: ReplyWriter,
  p: { orgId: string; reviewId: string; reviewName: string; publishedReplyId: string },
): Promise<void> {
  return client.deleteReply(p.reviewName, {
    orgId: p.orgId,
    idempotencyKey: deleteKey(p.reviewId, p.publishedReplyId),
  });
}
