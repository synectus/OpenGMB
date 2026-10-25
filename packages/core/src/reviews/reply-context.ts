import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { locations, reviews, type Tx } from "@opengmb/db";
import { DUPLICATE_WINDOW_REPLIES } from "../config/google-limits";
import type { GuardrailContext } from "../guardrails";
import { getWorkspaceReplySettings, type WorkspaceReplySettings } from "./workspace-settings";

/**
 * The guardrail context for `body` as a reply to `reviewId`. Settings come only from
 * `getWorkspaceReplySettings`. `recentReplies` are the location's most recent non-null
 * `reviews.reply_comment` (Google is the source of truth, so replies made in the Google UI count),
 * newest `reply_update_time` first, excluding this review. Returns the settings too, for the
 * approval decision.
 */
export async function buildGuardrailContext(
  tx: Tx,
  p: { reviewId: string; body: string },
): Promise<{ ctx: GuardrailContext; settings: WorkspaceReplySettings } | null> {
  const [row] = await tx
    .select({
      workspaceId: reviews.workspaceId,
      locationId: reviews.locationId,
      rating: reviews.starRating,
      comment: reviews.comment,
      reviewer: reviews.reviewerDisplayName,
      locationName: locations.name,
      locationTitle: locations.title,
      phone: locations.phone,
    })
    .from(reviews)
    .innerJoin(locations, eq(locations.id, reviews.locationId))
    .where(eq(reviews.id, p.reviewId));
  if (!row) return null;
  const settings = await getWorkspaceReplySettings(tx, row.workspaceId);
  const recent = await recentLocationReplies(tx, row.locationId, p.reviewId);
  const rating = row.rating;
  return {
    settings,
    ctx: {
      reply: p.body,
      review: {
        rating:
          rating !== null && rating >= 1 && rating <= 5 ? (rating as 1 | 2 | 3 | 4 | 5) : null,
        text: row.comment,
        reviewerDisplayName: row.reviewer,
      },
      location: { name: row.locationTitle ?? row.locationName, phone: row.phone },
      workspace: {
        profile: settings.profile,
        packs: settings.packs,
        skipPositiveReviews: settings.skipPositiveReviews,
        staffNames: settings.staffNames,
        ...(settings.h2Severity === "warn" ? { severityOverrides: { "H2.*": "warn" } } : {}),
      },
      recentReplies: recent,
    },
  };
}

/**
 * The location's most recent Google replies (the R6 window), newest first, optionally leaving out one
 * review's own reply. One query for `buildGuardrailContext` and for AI drafts, so R6.duplicate sees the
 * same history either way.
 */
export async function recentLocationReplies(
  tx: Tx,
  locationId: string,
  excludeReviewId?: string,
): Promise<string[]> {
  const rows = await tx
    .select({ comment: reviews.replyComment })
    .from(reviews)
    .where(
      and(
        eq(reviews.locationId, locationId),
        ...(excludeReviewId ? [ne(reviews.id, excludeReviewId)] : []),
        isNotNull(reviews.replyComment),
      ),
    )
    .orderBy(sql`${reviews.replyUpdateTime} desc nulls last`, desc(reviews.id))
    .limit(DUPLICATE_WINDOW_REPLIES);
  return rows.map((r) => r.comment!);
}

/** The workspace part of a guardrail context, from the workspace's reply settings. */
export function guardWorkspace(settings: WorkspaceReplySettings): GuardrailContext["workspace"] {
  return {
    profile: settings.profile,
    packs: settings.packs,
    skipPositiveReviews: settings.skipPositiveReviews,
    staffNames: settings.staffNames,
    ...(settings.h2Severity === "warn" ? { severityOverrides: { "H2.*": "warn" } } : {}),
  };
}
