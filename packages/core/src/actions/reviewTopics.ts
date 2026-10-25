import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { locations, reviews, reviewTopics, workspaceReviewTopicSettings, workspaces, type Tx } from "@opengmb/db";
import { AccessError, authorize, type Actor } from "../actor";
import { REVIEW_TOPICS, REVIEW_TOPIC_CONFIG, REVIEW_TOPIC_IDS } from "../config/review-topics";
import { CoreError } from "../errors";
import { aiEnv, AI_NOT_SET_UP, getAiModel } from "../ai/model";
import { defineAction } from "../registry";
import { ANALYTICS_CONFIG } from "../reviews/analytics";
import { filterConditions, scopeConditions, type ReviewFilters } from "../reviews/queries";
import { commentHashSql } from "../reviews/topic-filter";
import { computeTopicTrends, trendWindowStart, type TrendRow } from "../reviews/topic-trends";
import { classifyReviews, countPendingTopics } from "../reviews/topics";

async function requireWorkspace(tx: Tx, actor: Actor, workspaceId: string) {
  const [w] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, actor.orgId)));
  if (!w) throw new AccessError("NOT_FOUND", "Workspace not found");
}

export const reviewsClassifyTopics = defineAction({
  name: "reviews.classifyTopics",
  description: `Classify a client's reviews by topic and sentiment with AI (topics: ${REVIEW_TOPICS.map((t) => t.id).join(", ")}; sentiment positive, negative or mixed, per topic and overall). Takes reviews that have text and no current classification, newest first, up to ${REVIEW_TOPIC_CONFIG.maxPerRun} per run (remaining says how many still wait; run again). Several reviews go in one AI call. A review that was already classified and has not been edited is never classified or paid for again; an edited review is classified again. A review the AI answered badly twice is marked unclassified and is retried by the next run. Metered and capped like drafts: stopped 'cap' means a monthly AI limit was reached (what was done is kept), 'error' means the AI service failed. Only topics and sentiment are stored, never the review text, and review text is never logged. Optional locationIds narrows to those locations of the client. NOT_CONFIGURED when this server has no AI key. Needs review:draft (owner, admin, manager).`,
  input: z.object({
    workspaceId: z.uuid(),
    locationIds: z.array(z.uuid()).min(1).max(100).optional(),
  }),
  output: z.object({
    classified: z.number().int(),
    unclassified: z.number().int(),
    calls: z.number().int(),
    remaining: z.number().int(),
    stopped: z.enum(["cap", "error"]).nullable(),
    costMicroUsd: z.number().int(),
  }),
  permission: "review:draft",
  kind: "write",
  async preview(_ctx, input) {
    return {
      summary: `Classify this client's unclassified reviews by topic and sentiment with AI${input.locationIds ? ` (${input.locationIds.length} locations)` : ""}. Uses the client's monthly AI allowance. Only topics and sentiment are stored.`,
    };
  },
  async handler({ tx, db, actor, audit }, input) {
    authorize(actor, "review:draft", { workspaceId: input.workspaceId });
    await requireWorkspace(tx, actor, input.workspaceId);
    if (!getAiModel(aiEnv())) throw new CoreError("NOT_CONFIGURED", AI_NOT_SET_UP);
    if (input.locationIds) {
      const found = await tx
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.workspaceId, input.workspaceId), eq(locations.orgId, actor.orgId), inArray(locations.id, input.locationIds)));
      if (found.length !== new Set(input.locationIds).size) throw new AccessError("NOT_FOUND", "Location not found");
    }
    // Each batch is its own transaction on a separate connection (db), committed as the model answers; the
    // action's transaction only writes the summary audit row at the end.
    const r = await classifyReviews(db, {
      orgId: actor.orgId,
      workspaceId: input.workspaceId,
      userId: actor.userId,
      locationIds: input.locationIds,
      retryUnclassified: true,
    });
    // Counts only: never review text.
    await audit({
      action: "reviews.topics_classified",
      entityType: "workspace",
      entityId: input.workspaceId,
      after: { trigger: "manual", classified: r.classified, unclassified: r.unclassified, calls: r.calls, costMicroUsd: r.costMicroUsd, remaining: r.remaining, stopped: r.stopped },
    });
    return { classified: r.classified, unclassified: r.unclassified, calls: r.calls, remaining: r.remaining, stopped: r.stopped, costMicroUsd: r.costMicroUsd };
  },
});

export const reviewTopicsSetAuto = defineAction({
  name: "reviewTopics.setAuto",
  description:
    "Turn the daily automatic classification of a client's new reviews by topic and sentiment on or off. Off by default, because every classification uses the client's AI allowance. Needs review:configure (owner, admin).",
  input: z.object({ workspaceId: z.uuid(), enabled: z.boolean() }),
  output: z.object({ workspaceId: z.string(), enabled: z.boolean() }),
  permission: "review:configure",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "review:configure", { workspaceId: input.workspaceId });
    await requireWorkspace(tx, actor, input.workspaceId);
    const [before] = await tx
      .select({ on: workspaceReviewTopicSettings.autoClassify })
      .from(workspaceReviewTopicSettings)
      .where(eq(workspaceReviewTopicSettings.workspaceId, input.workspaceId));
    const values = { autoClassify: input.enabled, updatedAt: new Date(), updatedBy: actor.userId };
    await tx
      .insert(workspaceReviewTopicSettings)
      .values({ workspaceId: input.workspaceId, orgId: actor.orgId, ...values })
      .onConflictDoUpdate({ target: workspaceReviewTopicSettings.workspaceId, set: values });
    await audit({
      action: "review_topics.auto",
      entityType: "workspace",
      entityId: input.workspaceId,
      before: { autoClassify: before?.on ?? false },
      after: { autoClassify: input.enabled },
    });
    return { workspaceId: input.workspaceId, enabled: input.enabled };
  },
});

export const reviewTopicsStatus = defineAction({
  name: "reviewTopics.status",
  description:
    "Where a client's review classification stands: whether the daily automatic classification is on (autoClassify), whether AI is set up on this server (aiOn), how many reviews are classified (classified), could not be classified (unclassified) and still wait (pending: with text and no current classification, including unclassified ones a manual run would retry). Counts only. Needs review:read.",
  input: z.object({ workspaceId: z.uuid() }),
  output: z.object({
    workspaceId: z.string(),
    autoClassify: z.boolean(),
    aiOn: z.boolean(),
    classified: z.number().int(),
    unclassified: z.number().int(),
    pending: z.number().int(),
  }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    authorize(actor, "review:read", { workspaceId: input.workspaceId });
    await requireWorkspace(tx, actor, input.workspaceId);
    const [set] = await tx
      .select({ on: workspaceReviewTopicSettings.autoClassify })
      .from(workspaceReviewTopicSettings)
      .where(eq(workspaceReviewTopicSettings.workspaceId, input.workspaceId));
    const rows = await tx
      .select({ status: reviewTopics.status, n: sql<number>`count(*)::int` })
      .from(reviewTopics)
      .innerJoin(reviews, eq(reviews.id, reviewTopics.reviewId))
      .where(and(eq(reviewTopics.workspaceId, input.workspaceId), eq(reviewTopics.orgId, actor.orgId), eq(reviewTopics.textHash, commentHashSql)))
      .groupBy(reviewTopics.status);
    const n = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    const pending = await countPendingTopics(tx, {
      orgId: actor.orgId,
      workspaceId: input.workspaceId,
      userId: null,
      retryUnclassified: true,
    });
    return {
      workspaceId: input.workspaceId,
      autoClassify: set?.on ?? false,
      aiOn: getAiModel(aiEnv()) !== null,
      classified: n("classified"),
      unclassified: n("unclassified"),
      pending,
    };
  },
});

const counts = {
  total: z.number().int(),
  positive: z.number().int(),
  negative: z.number().int(),
  mixed: z.number().int(),
};
const line = z.object({
  topic: z.enum(REVIEW_TOPIC_IDS),
  label: z.string(),
  ...counts,
  positiveShare: z.number().nullable(),
  negativeShare: z.number().nullable(),
});

export const reviewsTopicTrends = defineAction({
  name: "reviews.topicTrends",
  description: `Review topics over the last ${REVIEW_TOPIC_CONFIG.trendWeeks} weeks (UTC weeks starting Monday, by the review's create time), from reviews already classified by reviews.classifyTopics (nothing here calls AI). For the whole scope: per topic the number of mentions (total) and how many were positive, negative or mixed, with positiveShare and negativeShare (0 to 1, null when no mentions), and the same counts for each week. Per location: the same per-topic counts over the window. Also classifiedReviews and the overall sentiment counts. Reviews edited since they were classified are left out until classified again. Filters: workspaceId, locationIds, groupId. Active locations in the caller's clients only. Counts only: no review text or reviewer names. truncated is true when more than ${ANALYTICS_CONFIG.maxRows} reviews matched.`,
  input: z.object({
    workspaceId: z.uuid().optional(),
    locationIds: z.array(z.uuid()).min(1).max(100).optional(),
    groupId: z.uuid().optional(),
  }),
  output: z.object({
    weeks: z.array(z.string()),
    classifiedReviews: z.number().int(),
    overall: z.object({ positive: z.number().int(), negative: z.number().int(), mixed: z.number().int() }),
    topics: z.array(line.extend({ weekly: z.array(z.object(counts)) })),
    locations: z.array(
      z.object({ locationId: z.string(), name: z.string(), classifiedReviews: z.number().int(), topics: z.array(line) }),
    ),
    truncated: z.boolean(),
  }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "review:read", { workspaceId: input.workspaceId });
    const now = new Date();
    const f: ReviewFilters = {
      workspaceId: input.workspaceId,
      locationIds: input.locationIds,
      groupId: input.groupId,
      from: trendWindowStart(now),
      to: new Date(now.getTime() + 1),
    };
    const found = await tx
      .select({
        locationId: reviews.locationId,
        locationName: locations.name,
        createTime: reviews.createTime,
        overall: reviewTopics.overallSentiment,
        topics: reviewTopics.topics,
      })
      .from(reviews)
      .innerJoin(locations, eq(locations.id, reviews.locationId))
      .innerJoin(reviewTopics, eq(reviewTopics.reviewId, reviews.id))
      .where(
        and(
          ...scopeConditions(actor),
          ...filterConditions(actor, f),
          eq(reviewTopics.status, "classified"),
          eq(reviewTopics.textHash, commentHashSql),
        ),
      )
      .limit(ANALYTICS_CONFIG.maxRows + 1);
    const truncated = found.length > ANALYTICS_CONFIG.maxRows;
    const rows = (truncated ? found.slice(0, ANALYTICS_CONFIG.maxRows) : found) as unknown as TrendRow[];
    return { ...computeTopicTrends(rows, now), truncated };
  },
});
