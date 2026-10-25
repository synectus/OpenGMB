import { inArray, eq } from "drizzle-orm";
import { locations, reviews, workspaces, type Tx } from "@opengmb/db";
import { z } from "zod";

/**
 * The `review.created` event body (the v1 contract; a snapshot test freezes its JSON Schema, so a
 * change fails with "breaking change: add a field, or plan /v2"). It carries review text and the
 * reviewer's display name on purpose: the receiver is the point. Audit rows never carry it.
 */
export const reviewCreatedPayload = z.object({
  type: z.literal("review.created"),
  test: z.boolean(),
  createdAt: z.string(),
  data: z.object({
    review: z.object({
      id: z.string(),
      workspaceId: z.string(),
      workspaceName: z.string(),
      locationId: z.string(),
      locationName: z.string(),
      googleReviewName: z.string(),
      starRating: z.number().int().min(1).max(5).nullable(),
      comment: z.string().nullable(),
      reviewerName: z.string().nullable(),
      createTime: z.string(),
      updateTime: z.string(),
      appUrl: z.string(),
    }),
  }),
});
export type ReviewCreatedPayload = z.infer<typeof reviewCreatedPayload>;

const appBase = () => (process.env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "");

/** One query for all reviews. Order follows `reviewIds`; ids that no longer exist are dropped. */
export async function buildReviewCreatedEvents(
  tx: Tx,
  reviewIds: string[],
  now: Date = new Date(),
): Promise<{ reviewId: string; workspaceId: string; payload: ReviewCreatedPayload }[]> {
  if (reviewIds.length === 0) return [];
  const rows = await tx
    .select({ r: reviews, workspaceName: workspaces.name, locationName: locations.name })
    .from(reviews)
    .innerJoin(workspaces, eq(workspaces.id, reviews.workspaceId))
    .innerJoin(locations, eq(locations.id, reviews.locationId))
    .where(inArray(reviews.id, reviewIds));
  const byId = new Map(rows.map((x) => [x.r.id, x]));
  const out: { reviewId: string; workspaceId: string; payload: ReviewCreatedPayload }[] = [];
  for (const id of reviewIds) {
    const x = byId.get(id);
    if (!x) continue;
    out.push({
      reviewId: id,
      workspaceId: x.r.workspaceId,
      payload: {
        type: "review.created",
        test: false,
        createdAt: now.toISOString(),
        data: {
          review: {
            id,
            workspaceId: x.r.workspaceId,
            workspaceName: x.workspaceName,
            locationId: x.r.locationId,
            locationName: x.locationName,
            googleReviewName: x.r.googleReviewName,
            starRating: x.r.starRating,
            comment: x.r.comment,
            reviewerName: x.r.reviewerIsAnonymous ? null : x.r.reviewerDisplayName,
            createTime: x.r.createTime.toISOString(),
            updateTime: x.r.updateTime.toISOString(),
            appUrl: `${appBase()}/reviews?review=${id}`,
          },
        },
      },
    });
  }
  return out;
}

/** A sample of the same shape for `webhooks.sendTest`. Not a real review; `test` is true. */
export function sampleReviewCreatedPayload(
  workspace: { id: string; name: string },
  now: Date = new Date(),
): ReviewCreatedPayload {
  const id = "00000000-0000-4000-8000-000000000000";
  return {
    type: "review.created",
    test: true,
    createdAt: now.toISOString(),
    data: {
      review: {
        id,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        locationId: "00000000-0000-4000-8000-000000000001",
        locationName: "Sample location",
        googleReviewName: "accounts/0/locations/0/reviews/sample",
        starRating: 5,
        comment: "This is a test event from OpenGMB.",
        reviewerName: "Sample reviewer",
        createTime: now.toISOString(),
        updateTime: now.toISOString(),
        appUrl: `${appBase()}/reviews?review=${id}`,
      },
    },
  };
}
