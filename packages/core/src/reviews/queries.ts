import { and, asc, desc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { locationGroupMembers, locations, reviewAssignments, reviews, workspaces, type Tx } from "@opengmb/db";
import { authorize, workspaceScope, type Actor } from "../actor";
import { CoreError } from "../errors";
import type { ReviewTopicId, TopicSentiment } from "../config/review-topics";
import { topicCondition } from "./topic-filter";
import { REPLY_STAGES, needsYouSql, noVisibleReply, replyStageSql, type ReplyStage } from "./reply-stage";

export type ReviewFilters = {
  workspaceId?: string;
  locationIds?: string[];
  groupId?: string;
  ratings?: number[];
  /** true: Google shows a reply. false: the review needs you (reply-stage.ts: needs_reply, draft, blocked, failed). */
  replied?: boolean;
  /** Google-visible only (none, or one Google rejected), ignoring drafts. For reviews.list_unreplied. */
  noVisibleReply?: boolean;
  /** createTime, inclusive */
  from?: Date;
  /** createTime, exclusive */
  to?: Date;
  /** Staff only (the action checks): reviews assigned to this user. */
  assignedToUserId?: string;
  /** Staff only (the action checks): assigned, due date passed, and still needing a reply. */
  overdue?: boolean;
  /** Text search: the review text, or the reviewer's name when the reviewer is not anonymous. Case-insensitive, matched literally. */
  q?: string;
  /** A5: reviews classified with this topic. With `sentiment`, that topic's sentiment. Edited-since-classified reviews match nothing. */
  topic?: ReviewTopicId;
  /** A5: the topic's sentiment when `topic` is set, otherwise the review's overall sentiment. */
  sentiment?: TopicSentiment;
};

export const REVIEW_SORTS = ["newest", "oldest", "rating_high", "rating_low"] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

/** `%`, `_` and the escape character itself are literal in a search, not wildcards. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

const cursorSchema = z.object({ t: z.string(), id: z.uuid(), r: z.number().int().optional() });

/**
 * A rating sort key that puts unrated reviews last: high-to-low reads 0 for none, low-to-high reads 6.
 * Used for both the ordering and the cursor.
 */
function ratingKey(sort: ReviewSort) {
  return sort === "rating_low"
    ? sql<number>`coalesce(${reviews.starRating}, 6)`
    : sql<number>`coalesce(${reviews.starRating}, 0)`;
}
const keyOf = (sort: ReviewSort, rating: number | null) => rating ?? (sort === "rating_low" ? 6 : 0);

/**
 * Keyset cursor over the sort order (the default is create_time desc, id desc). A rating sort also
 * carries the row's rating key, so pass `sort` and `starRating` for those. Opaque to callers.
 */
export function encodeCursor(
  row: { createTime: Date; id: string; starRating?: number | null },
  sort: ReviewSort = "newest",
): string {
  const payload: z.infer<typeof cursorSchema> = { t: row.createTime.toISOString(), id: row.id };
  if (sort === "rating_high" || sort === "rating_low") payload.r = keyOf(sort, row.starRating ?? null);
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeCursor(cursor: string): { t: string; id: string; r?: number } {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
    if (Number.isNaN(Date.parse(parsed.t))) throw new Error("bad time");
    return parsed;
  } catch {
    throw new CoreError("INVALID_INPUT", "Invalid cursor");
  }
}

export type ReviewRow = {
  id: string;
  googleReviewName: string;
  workspaceId: string;
  workspaceName: string;
  locationId: string;
  locationName: string;
  reviewerDisplayName: string | null;
  reviewerIsAnonymous: boolean;
  starRating: number | null;
  comment: string | null;
  createTime: Date;
  updateTime: Date;
  replyComment: string | null;
  replyUpdateTime: Date | null;
  replyState: string | null;
  replyPolicyViolation: string | null;
  /** The one definition of where the review stands (reply-stage.ts). */
  replyStage: ReplyStage;
};

const selection = {
  id: reviews.id,
  googleReviewName: reviews.googleReviewName,
  workspaceId: reviews.workspaceId,
  workspaceName: workspaces.name,
  locationId: reviews.locationId,
  locationName: locations.name,
  reviewerDisplayName: reviews.reviewerDisplayName,
  reviewerIsAnonymous: reviews.reviewerIsAnonymous,
  starRating: reviews.starRating,
  comment: reviews.comment,
  createTime: reviews.createTime,
  updateTime: reviews.updateTime,
  replyComment: reviews.replyComment,
  replyUpdateTime: reviews.replyUpdateTime,
  replyState: reviews.replyState,
  replyPolicyViolation: reviews.replyPolicyViolation,
  replyStage: replyStageSql,
};

/** Org + the actor's workspaces + active locations only. Every review read goes through this. */
export function scopeConditions(actor: Actor): (SQL | undefined)[] {
  const scope = workspaceScope(actor);
  return [
    eq(reviews.orgId, actor.orgId),
    eq(locations.orgId, actor.orgId),
    eq(locations.status, "active"),
    scope === "all" ? undefined : inArray(reviews.workspaceId, scope),
  ];
}

/** The caller-chosen filters as SQL conditions. The query needs `reviews` and `locations`. Shared with reviews.analytics. */
export function filterConditions(actor: Actor, f: ReviewFilters): (SQL | undefined)[] {
  return [
    f.workspaceId ? eq(reviews.workspaceId, f.workspaceId) : undefined,
    f.locationIds ? inArray(reviews.locationId, f.locationIds) : undefined,
    f.groupId
      ? sql`${reviews.locationId} in (select ${locationGroupMembers.locationId} from ${locationGroupMembers} where ${locationGroupMembers.groupId} = ${f.groupId} and ${locationGroupMembers.orgId} = ${actor.orgId})`
      : undefined,
    f.ratings ? inArray(reviews.starRating, f.ratings) : undefined,
    f.replied === undefined ? undefined : f.replied ? sql`not ${noVisibleReply}` : needsYouSql,
    f.noVisibleReply ? noVisibleReply : undefined,
    f.from ? gte(reviews.createTime, f.from) : undefined,
    f.to ? lt(reviews.createTime, f.to) : undefined,
    f.q ? searchCondition(f.q) : undefined,
    topicCondition(f),
    f.assignedToUserId
      ? sql`exists (select 1 from ${reviewAssignments} where ${reviewAssignments.reviewId} = ${reviews.id} and ${reviewAssignments.assigneeUserId} = ${f.assignedToUserId})`
      : undefined,
    f.overdue
      ? sql`(exists (select 1 from ${reviewAssignments} where ${reviewAssignments.reviewId} = ${reviews.id} and ${reviewAssignments.dueAt} < now()) and ${needsYouSql})`
      : undefined,
  ];
}

function searchCondition(q: string): SQL {
  const pattern = `%${escapeLike(q.trim())}%`;
  return sql`(${reviews.comment} ilike ${pattern} escape '\\' or (not ${reviews.reviewerIsAnonymous} and ${reviews.reviewerDisplayName} ilike ${pattern} escape '\\'))`;
}

/**
 * Reviews visible to `actor`, in `sort` order (default newest: create_time desc, id desc), strictly
 * after `cursor`. Ties always break newest first. Returns up to `limit` rows (callers pass limit+1
 * to detect another page).
 */
export async function queryReviews(
  tx: Tx,
  actor: Actor,
  f: ReviewFilters,
  page: { limit: number; cursor?: string; sort?: ReviewSort },
): Promise<ReviewRow[]> {
  if (f.workspaceId) authorize(actor, "review:read", { workspaceId: f.workspaceId });
  const sort = page.sort ?? "newest";
  const after = page.cursor ? decodeCursor(page.cursor) : null;
  const byRating = sort === "rating_high" || sort === "rating_low";
  if (after && byRating && after.r === undefined) throw new CoreError("INVALID_INPUT", "Invalid cursor");
  const key = ratingKey(sort);
  const tuple = (op: "<" | ">") =>
    op === "<"
      ? sql`(${reviews.createTime}, ${reviews.id}) < (${after!.t}::timestamptz, ${after!.id}::uuid)`
      : sql`(${reviews.createTime}, ${reviews.id}) > (${after!.t}::timestamptz, ${after!.id}::uuid)`;
  let afterCondition: SQL | undefined;
  if (after) {
    if (sort === "newest") afterCondition = tuple("<");
    else if (sort === "oldest") afterCondition = tuple(">");
    else {
      // rating_high: key desc; rating_low: key asc; then newest first
      const past = sort === "rating_high" ? sql`${key} < ${after.r}` : sql`${key} > ${after.r}`;
      afterCondition = or(past, and(sql`${key} = ${after.r}`, tuple("<")));
    }
  }
  const order =
    sort === "newest"
      ? [desc(reviews.createTime), desc(reviews.id)]
      : sort === "oldest"
        ? [asc(reviews.createTime), asc(reviews.id)]
        : [sort === "rating_high" ? desc(key) : asc(key), desc(reviews.createTime), desc(reviews.id)];
  return tx
    .select(selection)
    .from(reviews)
    .innerJoin(locations, eq(locations.id, reviews.locationId))
    .innerJoin(workspaces, eq(workspaces.id, reviews.workspaceId))
    .where(
      and(
        ...scopeConditions(actor),
        ...filterConditions(actor, f),
        afterCondition,
      ),
    )
    .orderBy(...order)
    .limit(page.limit) as Promise<ReviewRow[]>;
}

export async function getReviewRow(tx: Tx, actor: Actor, id: string): Promise<ReviewRow | null> {
  const [row] = await tx
    .select(selection)
    .from(reviews)
    .innerJoin(locations, eq(locations.id, reviews.locationId))
    .innerJoin(workspaces, eq(workspaces.id, reviews.workspaceId))
    .where(and(...scopeConditions(actor), eq(reviews.id, id)));
  return (row as ReviewRow | undefined) ?? null;
}

export const reviewItemOut = z.object({
  id: z.string(),
  /** Where the review stands on its reply: needs_reply, draft, blocked, failed (need you), waiting_approval, waiting_publish, replied, not_wanted. */
  replyStage: z.enum(REPLY_STAGES),
  googleReviewName: z.string(),
  location: z.object({ id: z.string(), name: z.string() }),
  reviewer: z.object({ displayName: z.string().nullable(), isAnonymous: z.boolean() }),
  rating: z.number().int().nullable(),
  comment: z.string().nullable(),
  createTime: z.string(),
  updateTime: z.string(),
  reply: z
    .object({
      comment: z.string(),
      updateTime: z.string().nullable(),
      /** Google's moderation: "APPROVED", "REJECTED" (stored but hidden from customers), or null. */
      state: z.string().nullable(),
      policyViolation: z.string().nullable(),
    })
    .nullable(),
});

export function toReviewItem(r: ReviewRow): z.input<typeof reviewItemOut> {
  return {
    id: r.id,
    replyStage: r.replyStage,
    googleReviewName: r.googleReviewName,
    location: { id: r.locationId, name: r.locationName },
    reviewer: { displayName: r.reviewerDisplayName, isAnonymous: r.reviewerIsAnonymous },
    rating: r.starRating,
    comment: r.comment,
    createTime: r.createTime.toISOString(),
    updateTime: r.updateTime.toISOString(),
    reply:
      r.replyComment === null
        ? null
        : {
            comment: r.replyComment,
            updateTime: r.replyUpdateTime?.toISOString() ?? null,
            state: r.replyState,
            policyViolation: r.replyPolicyViolation,
          },
  };
}
