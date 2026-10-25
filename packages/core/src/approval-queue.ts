import { and, count, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import {
  locations,
  postEdits,
  postTargets,
  posts,
  profileChangeSets,
  profileChangeTargets,
  reviewReplies,
  reviews,
  users,
  workspaces,
  type Tx,
} from "@opengmb/db";
import type { Actor } from "./actor";
import { CoreError } from "./errors";
import type { GuardrailResult } from "./guardrails";
import { roleHasPermission } from "./permissions";
import { postCapabilities } from "./posts/state";
import { touchedNames, type ProfileValues } from "./profile/fields";
import { changeSetCapabilities } from "./profile/state";
import { replyCapabilities } from "./reviews/reply-state";

/** The caller's workspace ids, or "all" (what `workspaceScope(actor)` returns). */
export type Scope = string[] | "all";

export type GuardrailSummary = {
  blocked: boolean;
  warnings: number;
  /** The author acknowledged the warnings when submitting. Change sets have no such step: always false. */
  warningsAcknowledged: boolean;
};

export function guardrailSummary(
  result: GuardrailResult | null,
  warningsAcknowledged: boolean,
): GuardrailSummary {
  const violations = result?.violations ?? [];
  return {
    blocked: violations.some((v) => v.severity === "block"),
    warnings: violations.filter((v) => v.severity === "warn").length,
    warningsAcknowledged,
  };
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

export function replyTitle(rating: number | null, reviewer: string | null): string {
  const what = rating === null ? "an unrated" : `a ${rating}★`;
  return `Reply to ${what} review${reviewer ? ` from ${reviewer}` : ""}`;
}

const TOPIC_LABEL: Record<string, string> = {
  STANDARD: "Update",
  EVENT: "Event",
  OFFER: "Offer",
  ALERT: "Alert",
};

export function postTitle(topicType: string, summary: string): string {
  return `${TOPIC_LABEL[topicType] ?? "Post"}: ${clip(summary, 60)}`;
}

export function postEditTitle(topicType: string, summary: string): string {
  return `Edit to a live ${(TOPIC_LABEL[topicType] ?? "Post").toLowerCase()}: ${clip(summary, 60)}`;
}

export function changeSetTitle(fieldNames: string[], locationCount: number): string {
  return `Profile change: ${fieldNames.join(", ")} on ${locationCount} ${
    locationCount === 1 ? "location" : "locations"
  }`;
}

export type ApprovalCounts = { reply: number; post: number; changeset: number; postedit: number; total: number };

/**
 * The one shape of the approvals count. `approvals.queue`, `approvals.counts` and `attention.*`
 * all build their numbers here, so the nav badge, Home, /approvals and the Reviews and Posts tabs cannot drift.
 */
export const approvalTotals = (n: {
  reply: number;
  post: number;
  changeset: number;
  postedit: number;
}): ApprovalCounts => ({
  reply: n.reply,
  post: n.post,
  changeset: n.changeset,
  postedit: n.postedit,
  total: n.reply + n.post + n.changeset + n.postedit,
});

/** Oldest submission first; the id keeps equal timestamps in a stable order. */
export const bySubmitted = (
  a: { submittedAt: string | null; id: string },
  b: { submittedAt: string | null; id: string },
) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "") || a.id.localeCompare(b.id);

/** What a group or location scope narrows the queue to: location ids, or a subquery that finds them. */
export type LocationNarrow = string[] | SQL;
const isEmpty = (ids: LocationNarrow) => Array.isArray(ids) && ids.length === 0;

/**
 * The active locations of a group, as a subquery. A group scope passes this instead of its ids, so a
 * group of 1,000 locations is one id, never a long IN list (H4; explicit id lists stay capped at 500).
 */
export const activeGroupMembers = (actor: Actor, groupId: string): SQL =>
  sql`(select m.location_id from location_group_members m inner join locations gl on gl.id = m.location_id where m.group_id = ${groupId} and m.org_id = ${actor.orgId} and gl.status = 'active')`;

/** A group id or a list of location ids, not both: whichever the caller sent, as a narrowing. */
export function narrowTo(actor: Actor, i: { groupId?: string; locationIds?: string[] }): LocationNarrow | undefined {
  if (i.groupId && i.locationIds) throw new CoreError("INVALID_INPUT", "Send groupId or locationIds, not both");
  return i.groupId ? activeGroupMembers(actor, i.groupId) : i.locationIds;
}

// One WHERE per kind, shared by the list and the count so the two cannot disagree.
export const replyWhere = (actor: Actor, scope: Scope, ws?: string, locationIds?: LocationNarrow) =>
  and(
    eq(reviewReplies.orgId, actor.orgId),
    eq(locations.status, "active"),
    // waitingApprovalSql (the review's reply stage is waiting_approval) without working the stage out for
    // every reply row ever sent: that stage means the review's one open reply (review_replies_one_open_per_review)
    // is pending approval, so the row itself is the pending one. Match that row only: matching every row of a
    // review that has a pending one also caught its published reply, so a pending edit counted twice (F9).
    eq(reviewReplies.status, "pending_approval"),
    scope === "all" ? undefined : inArray(reviewReplies.workspaceId, scope),
    ws ? eq(reviewReplies.workspaceId, ws) : undefined,
    locationIds ? inArray(reviews.locationId, locationIds) : undefined,
  );
/** A post waits for its current occurrence's targets; narrowing keeps it when one of them is in `ids`. */
const postHasTargetIn = (ids: LocationNarrow) =>
  isEmpty(ids)
    ? sql`false`
    : sql`exists (select 1 from ${postTargets} where ${postTargets.postId} = ${posts.id} and ${postTargets.occurrence} = ${posts.occurrence} and ${inArray(postTargets.locationId, ids)})`;
/** Same for a change set: one of its changing targets is at an active location in `ids`. */
const changeSetHasTargetIn = (ids: LocationNarrow) =>
  isEmpty(ids)
    ? sql`false`
    : sql`exists (select 1 from ${profileChangeTargets} inner join ${locations} on ${locations.id} = ${profileChangeTargets.locationId} where ${profileChangeTargets.changeSetId} = ${profileChangeSets.id} and ${profileChangeTargets.status} <> 'no_change' and ${locations.status} = 'active' and ${inArray(profileChangeTargets.locationId, ids)})`;

export const postWhere = (actor: Actor, scope: Scope, ws?: string, locationIds?: LocationNarrow) =>
  and(
    eq(posts.orgId, actor.orgId),
    eq(posts.status, "pending_approval"),
    scope === "all" ? undefined : inArray(posts.workspaceId, scope),
    ws ? eq(posts.workspaceId, ws) : undefined,
    locationIds ? postHasTargetIn(locationIds) : undefined,
  );
/** A change set waits only while at least one changing target is at an active location (apply skips the rest). */
const hasActiveChangingTarget = sql`exists (select 1 from ${profileChangeTargets} inner join ${locations} on ${locations.id} = ${profileChangeTargets.locationId} where ${profileChangeTargets.changeSetId} = ${profileChangeSets.id} and ${profileChangeTargets.status} <> 'no_change' and ${locations.status} = 'active')`;

export const changeSetWhere = (actor: Actor, scope: Scope, ws?: string, locationIds?: LocationNarrow) =>
  and(
    eq(profileChangeSets.orgId, actor.orgId),
    eq(profileChangeSets.status, "pending_approval"),
    hasActiveChangingTarget,
    scope === "all" ? undefined : inArray(profileChangeSets.workspaceId, scope),
    ws ? eq(profileChangeSets.workspaceId, ws) : undefined,
    locationIds ? changeSetHasTargetIn(locationIds) : undefined,
  );

export async function pendingReplies(tx: Tx, actor: Actor, scope: Scope, ws?: string, locationIds?: LocationNarrow) {
  const rows = await tx
    .select({
      reply: reviewReplies,
      review: reviews,
      workspaceName: workspaces.name,
      locationName: locations.name,
      createdByName: users.name,
    })
    .from(reviewReplies)
    .innerJoin(reviews, eq(reviews.id, reviewReplies.reviewId))
    .innerJoin(locations, eq(locations.id, reviews.locationId))
    .innerJoin(workspaces, eq(workspaces.id, reviewReplies.workspaceId))
    .leftJoin(users, eq(users.id, reviewReplies.createdBy))
    .where(replyWhere(actor, scope, ws, locationIds))
    .orderBy(reviewReplies.submittedAt, reviewReplies.id);
  return rows.map((r) => {
    const c = replyCapabilities(actor, r.reply.status);
    return {
      type: "reply" as const,
      id: r.reply.id,
      workspaceId: r.reply.workspaceId,
      workspaceName: r.workspaceName,
      locationNames: [r.locationName],
      submittedAt: r.reply.submittedAt?.toISOString() ?? null,
      text: r.reply.body,
      title: replyTitle(r.review.starRating, r.review.reviewerDisplayName),
      postId: null,
      reviewId: r.review.id,
      review: {
        rating: r.review.starRating,
        comment: r.review.comment,
        reviewerDisplayName: r.review.reviewerDisplayName,
      },
      topicType: null,
      warningsAcknowledged: r.reply.warningsAcknowledged,
      guardrail: guardrailSummary(
        r.reply.guardrailResult as GuardrailResult | null,
        r.reply.warningsAcknowledged,
      ),
      provenance: { createdSurface: r.reply.createdSurface, createdByName: r.createdByName ?? null },
      can: { approve: c.canApprove, reject: c.canReject },
    };
  });
}

export async function pendingPosts(tx: Tx, actor: Actor, scope: Scope, ws?: string, locationIds?: LocationNarrow) {
  const rows = await tx
    .select({ post: posts, workspaceName: workspaces.name, createdByName: users.name })
    .from(posts)
    .innerJoin(workspaces, eq(workspaces.id, posts.workspaceId))
    .leftJoin(users, eq(users.id, posts.createdBy))
    .where(postWhere(actor, scope, ws, locationIds))
    .orderBy(posts.submittedAt, posts.id);
  const targets = rows.length
    ? await tx
        .select({
          postId: postTargets.postId,
          occurrence: postTargets.occurrence,
          name: locations.name,
        })
        .from(postTargets)
        .innerJoin(locations, eq(locations.id, postTargets.locationId))
        .where(
          inArray(
            postTargets.postId,
            rows.map((r) => r.post.id),
          ),
        )
    : [];
  return rows.map((r) => {
    const c = postCapabilities(actor, r.post.status);
    return {
      type: "post" as const,
      id: r.post.id,
      workspaceId: r.post.workspaceId,
      workspaceName: r.workspaceName,
      locationNames: targets
        .filter((t) => t.postId === r.post.id && t.occurrence === r.post.occurrence)
        .map((t) => t.name)
        .sort(),
      submittedAt: r.post.submittedAt?.toISOString() ?? null,
      text: r.post.summary,
      title: postTitle(r.post.topicType, r.post.summary),
      postId: null,
      reviewId: null,
      review: null,
      topicType: r.post.topicType,
      warningsAcknowledged: r.post.warningsAcknowledged,
      guardrail: guardrailSummary(
        r.post.guardrailResult as GuardrailResult | null,
        r.post.warningsAcknowledged,
      ),
      provenance: { createdSurface: r.post.createdSurface, createdByName: r.createdByName ?? null },
      can: { approve: c.canApprove, reject: c.canReject },
    };
  });
}

/** Profile change sets waiting for approval that still change at least one active location. Not used by portal.overview. Only active changing locations are named. */
export async function pendingChangeSets(tx: Tx, actor: Actor, scope: Scope, ws?: string, locationIds?: LocationNarrow) {
  const rows = await tx
    .select({ cs: profileChangeSets, workspaceName: workspaces.name, createdByName: users.name })
    .from(profileChangeSets)
    .innerJoin(workspaces, eq(workspaces.id, profileChangeSets.workspaceId))
    .leftJoin(users, eq(users.id, profileChangeSets.createdBy))
    .where(changeSetWhere(actor, scope, ws, locationIds))
    .orderBy(profileChangeSets.submittedAt, profileChangeSets.id);
  const targets = rows.length
    ? await tx
        .select({ changeSetId: profileChangeTargets.changeSetId, name: locations.name })
        .from(profileChangeTargets)
        .innerJoin(locations, eq(locations.id, profileChangeTargets.locationId))
        .where(
          and(
            inArray(
              profileChangeTargets.changeSetId,
              rows.map((r) => r.cs.id),
            ),
            ne(profileChangeTargets.status, "no_change"),
            eq(locations.status, "active"),
          ),
        )
        .orderBy(locations.name)
    : [];
  return rows.map((r) => {
    const c = changeSetCapabilities(actor, r.cs.status);
    const names = targets.filter((t) => t.changeSetId === r.cs.id).map((t) => t.name);
    const fieldNames = touchedNames(r.cs.fields as ProfileValues);
    return {
      type: "changeset" as const,
      id: r.cs.id,
      workspaceId: r.cs.workspaceId,
      workspaceName: r.workspaceName,
      locationNames: names,
      submittedAt: r.cs.submittedAt?.toISOString() ?? null,
      text: fieldNames.join(", "),
      title: changeSetTitle(fieldNames, names.length),
      postId: null,
      reviewId: null,
      review: null,
      topicType: null,
      warningsAcknowledged: false,
      guardrail: guardrailSummary(r.cs.guardrailResult as GuardrailResult | null, false),
      provenance: { createdSurface: r.cs.createdSurface, createdByName: r.createdByName ?? null },
      can: { approve: c.canApprove, reject: c.canReject },
    };
  });
}

/**
 * An edit of a published post waits while at least one live Google post it would patch (the post's
 * current occurrence, published, with a Google name) is at an active location. The post itself stays
 * `published`, so it is never also counted as a waiting post. Narrowing keeps it when one of those is in `ids`.
 */
const postEditHasLiveTarget = (ids?: LocationNarrow) =>
  ids && isEmpty(ids)
    ? sql`false`
    : sql`exists (select 1 from ${postTargets} inner join ${posts} on ${posts.id} = ${postTargets.postId} inner join ${locations} on ${locations.id} = ${postTargets.locationId} where ${postTargets.postId} = ${postEdits.postId} and ${postTargets.occurrence} = ${posts.occurrence} and ${postTargets.status} = 'published' and ${postTargets.googlePostName} is not null and ${locations.status} = 'active'${ids ? sql` and ${inArray(postTargets.locationId, ids)}` : sql``})`;

export const postEditWhere = (actor: Actor, scope: Scope, ws?: string, locationIds?: LocationNarrow) =>
  and(
    eq(postEdits.orgId, actor.orgId),
    eq(postEdits.status, "pending_approval"),
    scope === "all" ? undefined : inArray(postEdits.workspaceId, scope),
    ws ? eq(postEdits.workspaceId, ws) : undefined,
    postEditHasLiveTarget(locationIds),
  );

/** Edits of published posts waiting for approval. Only locations the edit would patch are named. */
export async function pendingPostEdits(tx: Tx, actor: Actor, scope: Scope, ws?: string, locationIds?: LocationNarrow) {
  const rows = await tx
    .select({ edit: postEdits, post: posts, workspaceName: workspaces.name, createdByName: users.name })
    .from(postEdits)
    .innerJoin(posts, eq(posts.id, postEdits.postId))
    .innerJoin(workspaces, eq(workspaces.id, postEdits.workspaceId))
    .leftJoin(users, eq(users.id, postEdits.createdBy))
    .where(postEditWhere(actor, scope, ws, locationIds))
    .orderBy(postEdits.createdAt, postEdits.id);
  const targets = rows.length
    ? await tx
        .select({ postId: postTargets.postId, name: locations.name, occurrence: postTargets.occurrence })
        .from(postTargets)
        .innerJoin(locations, eq(locations.id, postTargets.locationId))
        .where(
          and(
            inArray(
              postTargets.postId,
              rows.map((r) => r.post.id),
            ),
            eq(postTargets.status, "published"),
            sql`${postTargets.googlePostName} is not null`,
            eq(locations.status, "active"),
          ),
        )
    : [];
  return rows.map((r) => {
    const mayDecide = roleHasPermission(actor.role, "review:approve");
    return {
      type: "postedit" as const,
      id: r.edit.id,
      postId: r.post.id,
      workspaceId: r.edit.workspaceId,
      workspaceName: r.workspaceName,
      locationNames: targets
        .filter((t) => t.postId === r.post.id && t.occurrence === r.post.occurrence)
        .map((t) => t.name)
        .sort(),
      submittedAt: r.edit.createdAt.toISOString(),
      text: r.edit.summary,
      title: postEditTitle(r.post.topicType, r.edit.summary),
      reviewId: null,
      review: null,
      topicType: r.post.topicType,
      warningsAcknowledged: r.edit.warningsAcknowledged,
      guardrail: guardrailSummary(r.edit.guardrailResult as GuardrailResult | null, r.edit.warningsAcknowledged),
      provenance: { createdSurface: r.edit.createdSurface, createdByName: r.createdByName ?? null },
      can: { approve: mayDecide, reject: mayDecide },
    };
  });
}

/** Count queries only, for the nav badge. Uses the same WHERE as the list. */
export async function countPending(tx: Tx, actor: Actor, scope: Scope, ws?: string, locationIds?: LocationNarrow) {
  const [[r], [p], [c], [e]] = await Promise.all([
    tx
      .select({ n: count() })
      .from(reviewReplies)
      .innerJoin(reviews, eq(reviews.id, reviewReplies.reviewId))
      .innerJoin(locations, eq(locations.id, reviews.locationId))
      .where(replyWhere(actor, scope, ws, locationIds)),
    tx.select({ n: count() }).from(posts).where(postWhere(actor, scope, ws, locationIds)),
    tx.select({ n: count() }).from(profileChangeSets).where(changeSetWhere(actor, scope, ws, locationIds)),
    tx.select({ n: count() }).from(postEdits).where(postEditWhere(actor, scope, ws, locationIds)),
  ]);
  return approvalTotals({ reply: r?.n ?? 0, post: p?.n ?? 0, changeset: c?.n ?? 0, postedit: e?.n ?? 0 });
}
