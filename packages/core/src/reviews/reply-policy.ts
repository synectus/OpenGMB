import type { WorkspaceReplySettings } from "./workspace-settings";

/**
 * Whether an AI/agent should bother drafting a reply to a review. Used by `reviews.list_unreplied`
 * so the bulk tool does not keep surfacing reviews whose replies will be blocked (G4: with the
 * workspace's `skipPositiveReviews` on, 4-5 star reviews are skipped; the `hipaa` rule
 * `H.skip-positive` blocks them at submit and publish).
 */
export type ReplyPolicyReview = { starRating: number | null; comment: string | null };
/** The workspace's reply settings (id and name are accepted for older callers and ignored). */
export type ReplyPolicyWorkspace = Partial<Pick<WorkspaceReplySettings, "skipPositiveReviews">> & {
  id?: string;
  name?: string;
};
export type ReplyPolicy = { replyAllowed: boolean; skipReason: string | null };

export const SKIP_POSITIVE_REASON = "Healthcare profile: replies to positive reviews are off";

export function replyPolicy(
  review: ReplyPolicyReview,
  workspace: ReplyPolicyWorkspace,
): ReplyPolicy {
  if (workspace.skipPositiveReviews && review.starRating !== null && review.starRating >= 4) {
    return { replyAllowed: false, skipReason: SKIP_POSITIVE_REASON };
  }
  return { replyAllowed: true, skipReason: null };
}
