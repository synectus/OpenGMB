import { alias } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, sql, type Column } from "drizzle-orm";
import {
  googleConnections,
  locations,
  mcpProposals,
  memberships,
  organizations,
  performanceDaily,
  postEdits,
  postTargets,
  posts,
  profileChangeSets,
  profileChangeTargets,
  profileChanges,
  reviewReplies,
  reviewSyncs,
  reviews,
  users,
  workspaceReplySettings,
  workspaces,
  type Tx,
} from "@opengmb/db";
import { workspaceScope, type Actor } from "./actor";
import {
  approvalTotals,
  changeSetWhere,
  pendingChangeSets,
  pendingPostEdits,
  pendingPosts,
  pendingReplies,
  postEditWhere,
  postWhere,
  replyWhere,
  type Scope,
} from "./approval-queue";
import { NEGATIVE_REVIEW_MAX_STARS } from "./config/review-alerts";
import { invitationCount } from "./invitations/core";
import { clip } from "./locations/overview";
import { locationStats } from "./locations/stats";
import { addMonths, last30DaysRange, monthOf, monthStart, monthsBetween, ymd } from "./performance/dates";
import { byLocation } from "./performance/queries";
import { lastPostDates } from "./posts/scope";
import { listProposals } from "./proposals";
import type { ActionContext } from "./registry";
import { scopeConditions } from "./reviews/queries";
import { OPEN_REPLY_STATUSES, TO_ANSWER_STAGES, noVisibleReply, replyStageSql, stageIn, stageSqlWithOpen, toAnswerSql } from "./reviews/reply-stage";

/**
 * Home's owner layout (location cards) covers up to this many active locations; the web picks the
 * layout with the same number (COMFORTABLE_MAX_LOCATIONS; apps/web/lib/home.test.ts pins them equal).
 */
export const HOME_OWNER_MAX_LOCATIONS = 3;

/** Most urgent first. The index is the tier; within a tier, newest first. */
export const ATTENTION_KINDS = ["failed", "negative_review", "approval", "proposal", "change", "review"] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export function byUrgency(
  a: { kind: AttentionKind; at: string; id: string },
  b: { kind: AttentionKind; at: string; id: string },
): number {
  return (
    ATTENTION_KINDS.indexOf(a.kind) - ATTENTION_KINDS.indexOf(b.kind) ||
    b.at.localeCompare(a.at) ||
    a.id.localeCompare(b.id)
  );
}

export const negativeRating = sql`${reviews.starRating} <= ${NEGATIVE_REVIEW_MAX_STARS}`;
export const otherRating = sql`(${reviews.starRating} is null or ${reviews.starRating} > ${NEGATIVE_REVIEW_MAX_STARS})`;

/**
 * A review a person should answer now: the shared reply stage (reviews/reply-stage.ts) is
 * needs_reply, draft or blocked. Pending approval is the Approvals bucket, failed is the Failed
 * bucket, approved-not-published is `waitingToPublish` (counted apart, not in the total).
 */
export const awaitsReply = toAnswerSql;
export const FAILED_SET_STATUSES = ["failed", "partially_applied"] as const;

export const wsFilter = (col: Column, scope: Scope, ws?: string) =>
  and(scope === "all" ? undefined : inArray(col, scope), ws ? eq(col, ws) : undefined);
export const reviewScope = (actor: Actor, ws?: string) =>
  and(...scopeConditions(actor), ws ? eq(reviews.workspaceId, ws) : undefined);
export const openChangeWhere = (actor: Actor, scope: Scope, ws?: string) =>
  and(eq(profileChanges.orgId, actor.orgId), eq(profileChanges.status, "open"), wsFilter(locations.workspaceId, scope, ws));
export const failedReplyWhere = (actor: Actor, scope: Scope, ws?: string) =>
  and(
    eq(reviewReplies.orgId, actor.orgId),
    eq(reviewReplies.status, "failed"),
    eq(locations.status, "active"),
    wsFilter(reviewReplies.workspaceId, scope, ws),
  );
export const failedPostWhere = (actor: Actor, scope: Scope, ws?: string) =>
  and(eq(posts.orgId, actor.orgId), eq(posts.status, "failed"), wsFilter(posts.workspaceId, scope, ws));
export const failedSetWhere = (actor: Actor, scope: Scope, ws?: string) =>
  and(
    eq(profileChangeSets.orgId, actor.orgId),
    inArray(profileChangeSets.status, [...FAILED_SET_STATUSES]),
    wsFilter(profileChangeSets.workspaceId, scope, ws),
  );

export type WorkspaceCounts = {
  reply: number;
  post: number;
  changeset: number;
  postedit: number;
  negative: number;
  other: number;
  changes: number;
  failedReply: number;
  /** Reviews whose reply is approved but not yet on Google. Not part of any total. */
  waitingToPublish: number;
  failedPost: number;
  failedChangeset: number;
};
const ZERO: WorkspaceCounts = {
  reply: 0, post: 0, changeset: 0, postedit: 0, negative: 0, other: 0, changes: 0, failedReply: 0, waitingToPublish: 0, failedPost: 0, failedChangeset: 0,
};
const n = sql<number>`count(*)::int`;
// The review's one open reply (unique partial index), joined once so the reply stage is worked out from it.
const openReply = alias(reviewReplies, "open_reply");
const toAnswer = stageIn(stageSqlWithOpen(sql`${openReply.status}::text`), TO_ANSWER_STAGES);

/** Every bucket except proposals (a person's, not a workspace's), grouped by workspace. One query per bucket. */
export async function countsByWorkspace(tx: Tx, actor: Actor, scope: Scope, ws?: string) {
  const [rp, pp, cp, ep, rv, wp, ch, fr, fp, fc] = await Promise.all([
    tx
      .select({ ws: reviewReplies.workspaceId, n })
      .from(reviewReplies)
      .innerJoin(reviews, eq(reviews.id, reviewReplies.reviewId))
      .innerJoin(locations, eq(locations.id, reviews.locationId))
      .where(replyWhere(actor, scope, ws))
      .groupBy(reviewReplies.workspaceId),
    tx.select({ ws: posts.workspaceId, n }).from(posts).where(postWhere(actor, scope, ws)).groupBy(posts.workspaceId),
    tx
      .select({ ws: profileChangeSets.workspaceId, n })
      .from(profileChangeSets)
      .where(changeSetWhere(actor, scope, ws))
      .groupBy(profileChangeSets.workspaceId),
    tx
      .select({ ws: postEdits.workspaceId, n })
      .from(postEdits)
      .where(postEditWhere(actor, scope, ws))
      .groupBy(postEdits.workspaceId),
    // H4: the reply stage of a review is worked out only for reviews with no visible reply (a partial
    // index finds them): every stage that counts here (needs_reply, draft, blocked) implies one, so the
    // rest, usually most of the table, would only be scanned. Waiting-to-publish is the other case, a
    // reply approved but not on Google, found through its reply row instead (one open reply per review).
    tx
      .select({
        ws: reviews.workspaceId,
        negative: sql<number>`(count(*) filter (where ${toAnswer} and ${negativeRating}))::int`,
        other: sql<number>`(count(*) filter (where ${toAnswer} and ${otherRating}))::int`,
      })
      .from(reviews)
      .innerJoin(locations, eq(locations.id, reviews.locationId))
      .leftJoin(openReply, and(eq(openReply.reviewId, reviews.id), inArray(openReply.status, [...OPEN_REPLY_STATUSES])))
      .where(and(reviewScope(actor, ws), noVisibleReply))
      .groupBy(reviews.workspaceId),
    tx
      .select({ ws: reviews.workspaceId, n: sql<number>`count(distinct ${reviews.id})::int` })
      .from(reviewReplies)
      .innerJoin(reviews, eq(reviews.id, reviewReplies.reviewId))
      .innerJoin(locations, eq(locations.id, reviews.locationId))
      .where(and(reviewScope(actor, ws), eq(reviewReplies.status, "approved")))
      .groupBy(reviews.workspaceId),
    tx
      .select({ ws: locations.workspaceId, n })
      .from(profileChanges)
      .innerJoin(locations, eq(locations.id, profileChanges.locationId))
      .where(openChangeWhere(actor, scope, ws))
      .groupBy(locations.workspaceId),
    tx
      .select({ ws: reviewReplies.workspaceId, n })
      .from(reviewReplies)
      .innerJoin(reviews, eq(reviews.id, reviewReplies.reviewId))
      .innerJoin(locations, eq(locations.id, reviews.locationId))
      .where(failedReplyWhere(actor, scope, ws))
      .groupBy(reviewReplies.workspaceId),
    tx.select({ ws: posts.workspaceId, n }).from(posts).where(failedPostWhere(actor, scope, ws)).groupBy(posts.workspaceId),
    tx
      .select({ ws: profileChangeSets.workspaceId, n })
      .from(profileChangeSets)
      .where(failedSetWhere(actor, scope, ws))
      .groupBy(profileChangeSets.workspaceId),
  ]);
  const out = new Map<string, WorkspaceCounts>();
  const add = (rows: { ws: string; n: number }[], key: keyof WorkspaceCounts) => {
    for (const r of rows) {
      const c = out.get(r.ws) ?? { ...ZERO };
      c[key] += r.n;
      out.set(r.ws, c);
    }
  };
  add(rp, "reply");
  add(pp, "post");
  add(cp, "changeset");
  add(ep, "postedit");
  add(rv.map((r) => ({ ws: r.ws, n: r.negative })), "negative");
  add(rv.map((r) => ({ ws: r.ws, n: r.other })), "other");
  add(wp, "waitingToPublish");
  add(ch, "changes");
  add(fr, "failedReply");
  add(fp, "failedPost");
  add(fc, "failedChangeset");
  return out;
}

/** The caller's own pending, unexpired proposals: the rows listProposals({ status: "pending" }) returns. */
export async function countOwnPendingProposals(tx: Tx, actor: Actor, now: Date): Promise<number> {
  const [r] = await tx
    .select({ n })
    .from(mcpProposals)
    .where(
      and(
        eq(mcpProposals.orgId, actor.orgId),
        eq(mcpProposals.userId, actor.userId),
        actor.apiTokenId ? eq(mcpProposals.tokenId, actor.apiTokenId) : undefined,
        eq(mcpProposals.status, "pending"),
        gt(mcpProposals.expiresAt, now),
      ),
    );
  return r?.n ?? 0;
}

/** One workspace's number in the client list. */
export const workspaceAttention = (c: WorkspaceCounts = ZERO) =>
  c.reply + c.post + c.changeset + c.postedit + c.negative + c.other + c.changes + c.failedReply + c.failedPost + c.failedChangeset;

export function totalCounts(byWs: Iterable<WorkspaceCounts>, proposals: number) {
  const s = { ...ZERO };
  for (const c of byWs) for (const k of Object.keys(s) as (keyof WorkspaceCounts)[]) s[k] += c[k];
  const approvals = approvalTotals(s);
  const reviewCounts = { negative: s.negative, other: s.other, total: s.negative + s.other };
  const failed = {
    reply: s.failedReply,
    post: s.failedPost,
    changeset: s.failedChangeset,
    total: s.failedReply + s.failedPost + s.failedChangeset,
  };
  return {
    approvals,
    reviews: reviewCounts,
    changes: s.changes,
    waitingToPublish: s.waitingToPublish,
    proposals,
    failed,
    total: approvals.total + reviewCounts.total + s.changes + proposals + failed.total,
    negativeMaxStars: NEGATIVE_REVIEW_MAX_STARS,
  };
}

export async function countAttention(tx: Tx, actor: Actor, ws: string | undefined, now: Date) {
  const byWs = await countsByWorkspace(tx, actor, workspaceScope(actor), ws);
  return { byWs, counts: totalCounts(byWs.values(), await countOwnPendingProposals(tx, actor, now)) };
}

export const CLIENT_TREND_MONTHS = 6;
const CLIP = 120;
const isoUtc = (col: unknown) =>
  sql<string | null>`to_char(max(${col}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const avg2 = (v: string | null | undefined) => (v == null ? null : Math.round(Number(v) * 100) / 100);

export type AttentionItem = {
  kind: AttentionKind;
  subject: "reply" | "post" | "changeset" | "postedit" | "review" | "change" | "proposal";
  id: string;
  reviewId: string | null;
  locationId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  locationNames: string[];
  at: string;
  title: string;
  detail: string | null;
  code: string | null;
  rating: number | null;
  replyStatus: "draft" | "blocked" | null;
  fields: string[];
  googleSuggested: boolean;
  provenance: { createdSurface: string | null; createdByName: string | null };
  expiresAt: string | null;
};
const BLANK = {
  reviewId: null, locationId: null, workspaceId: null, workspaceName: null, locationNames: [] as string[],
  detail: null, code: null, rating: null, replyStatus: null, fields: [] as string[], googleSuggested: false,
  provenance: { createdSurface: null, createdByName: null }, expiresAt: null,
} satisfies Partial<AttentionItem>;

export async function approvalItems(tx: Tx, actor: Actor, scope: Scope, ws?: string): Promise<AttentionItem[]> {
  const [r, p, c, e] = await Promise.all([
    pendingReplies(tx, actor, scope, ws),
    pendingPosts(tx, actor, scope, ws),
    pendingChangeSets(tx, actor, scope, ws),
    pendingPostEdits(tx, actor, scope, ws),
  ]);
  return [...r, ...p, ...c, ...e].map((i) => ({
    ...BLANK,
    kind: "approval",
    subject: i.type,
    id: i.id,
    reviewId: i.reviewId,
    workspaceId: i.workspaceId,
    workspaceName: i.workspaceName,
    locationNames: i.locationNames,
    at: i.submittedAt ?? "",
    title: i.title,
    rating: i.review?.rating ?? null,
    provenance: i.provenance,
  }));
}

export async function reviewItems(
  tx: Tx, actor: Actor, ws: string | undefined, which: "negative" | "other", limit: number,
): Promise<AttentionItem[]> {
  const rows = await tx
    .select({
      id: reviews.id, locationId: reviews.locationId, workspaceId: reviews.workspaceId, workspaceName: workspaces.name,
      locationName: locations.name, rating: reviews.starRating, comment: reviews.comment, createTime: reviews.createTime,
      stage: replyStageSql,
    })
    .from(reviews)
    .innerJoin(locations, eq(locations.id, reviews.locationId))
    .innerJoin(workspaces, eq(workspaces.id, reviews.workspaceId))
    .where(and(reviewScope(actor, ws), awaitsReply, which === "negative" ? negativeRating : otherRating))
    .orderBy(desc(reviews.createTime), desc(reviews.id))
    .limit(limit);
  return rows.map((r) => ({
    ...BLANK,
    kind: which === "negative" ? "negative_review" : "review",
    subject: "review",
    id: r.id,
    reviewId: r.id,
    locationId: r.locationId,
    workspaceId: r.workspaceId,
    workspaceName: r.workspaceName,
    locationNames: [r.locationName],
    at: r.createTime.toISOString(),
    title: r.rating === null ? "Unrated review, no reply" : `${r.rating}★ review, no reply`,
    detail: r.comment ? clip(r.comment, CLIP) : null,
    rating: r.rating,
    replyStatus: r.stage === "draft" || r.stage === "blocked" ? r.stage : null,
  }));
}

export async function changeItems(tx: Tx, actor: Actor, scope: Scope, ws: string | undefined, limit: number) {
  const rows = await tx
    .select({
      id: profileChanges.id, locationId: profileChanges.locationId, locationName: locations.name,
      workspaceId: locations.workspaceId, workspaceName: workspaces.name, fieldPaths: profileChanges.fieldPaths,
      googleSuggested: profileChanges.googleSuggested, detectedAt: profileChanges.detectedAt,
    })
    .from(profileChanges)
    .innerJoin(locations, eq(locations.id, profileChanges.locationId))
    .innerJoin(workspaces, eq(workspaces.id, locations.workspaceId))
    .where(openChangeWhere(actor, scope, ws))
    .orderBy(desc(profileChanges.detectedAt), desc(profileChanges.id))
    .limit(limit);
  return rows.map((r): AttentionItem => ({
    ...BLANK,
    kind: "change",
    subject: "change",
    id: r.id,
    locationId: r.locationId,
    workspaceId: r.workspaceId,
    workspaceName: r.workspaceName,
    locationNames: [r.locationName],
    at: r.detectedAt.toISOString(),
    title: r.googleSuggested
      ? `Google suggests a change to ${r.fieldPaths.join(", ")}`
      : `${r.fieldPaths.join(", ")} changed outside OpenGMB`,
    fields: r.fieldPaths,
    googleSuggested: r.googleSuggested,
  }));
}

export async function failedItems(tx: Tx, actor: Actor, scope: Scope, ws: string | undefined, limit: number) {
  const [r, p, c] = await Promise.all([
    tx
      .select({
        id: reviewReplies.id, reviewId: reviews.id, locationId: locations.id, locationName: locations.name,
        workspaceId: reviewReplies.workspaceId, workspaceName: workspaces.name, at: reviewReplies.updatedAt,
        code: reviewReplies.failureReason, surface: reviewReplies.createdSurface, by: users.name,
      })
      .from(reviewReplies)
      .innerJoin(reviews, eq(reviews.id, reviewReplies.reviewId))
      .innerJoin(locations, eq(locations.id, reviews.locationId))
      .innerJoin(workspaces, eq(workspaces.id, reviewReplies.workspaceId))
      .leftJoin(users, eq(users.id, reviewReplies.createdBy))
      .where(failedReplyWhere(actor, scope, ws))
      .orderBy(desc(reviewReplies.updatedAt))
      .limit(limit),
    tx
      .select({
        id: posts.id, workspaceId: posts.workspaceId, workspaceName: workspaces.name, at: posts.updatedAt,
        surface: posts.createdSurface, by: users.name,
        code: sql<string | null>`(select ${postTargets.error} from ${postTargets} where ${postTargets.postId} = ${posts.id} and ${postTargets.status} = 'failed' order by ${postTargets.updatedAt} desc limit 1)`,
      })
      .from(posts)
      .innerJoin(workspaces, eq(workspaces.id, posts.workspaceId))
      .leftJoin(users, eq(users.id, posts.createdBy))
      .where(failedPostWhere(actor, scope, ws))
      .orderBy(desc(posts.updatedAt))
      .limit(limit),
    tx
      .select({
        id: profileChangeSets.id, status: profileChangeSets.status, workspaceId: profileChangeSets.workspaceId,
        workspaceName: workspaces.name, at: profileChangeSets.updatedAt, surface: profileChangeSets.createdSurface,
        by: users.name,
        code: sql<string | null>`(select ${profileChangeTargets.error} from ${profileChangeTargets} where ${profileChangeTargets.changeSetId} = ${profileChangeSets.id} and ${profileChangeTargets.status} = 'failed' limit 1)`,
      })
      .from(profileChangeSets)
      .innerJoin(workspaces, eq(workspaces.id, profileChangeSets.workspaceId))
      .leftJoin(users, eq(users.id, profileChangeSets.createdBy))
      .where(failedSetWhere(actor, scope, ws))
      .orderBy(desc(profileChangeSets.updatedAt))
      .limit(limit),
  ]);
  const base = (x: { id: string; workspaceId: string; workspaceName: string; at: Date; code: string | null; surface: string; by: string | null }) => ({
    ...BLANK,
    kind: "failed" as const,
    id: x.id,
    workspaceId: x.workspaceId,
    workspaceName: x.workspaceName,
    at: x.at.toISOString(),
    code: x.code,
    provenance: { createdSurface: x.surface, createdByName: x.by },
  });
  return [
    ...r.map((x): AttentionItem => ({ ...base(x), subject: "reply", reviewId: x.reviewId, locationId: x.locationId, locationNames: [x.locationName], title: "Reply not published" })),
    ...p.map((x): AttentionItem => ({ ...base(x), subject: "post", title: "Post not published" })),
    ...c.map((x): AttentionItem => ({
      ...base(x),
      subject: "changeset",
      title: x.status === "partially_applied" ? "Profile change partly applied" : "Profile change not applied",
    })),
  ];
}

/** Same rule as apps/web/lib/agents.ts proposalTitle: the preview's first sentence, else "Run <action>". */
export function proposalSummary(action: string, preview: unknown): string {
  const s = (preview as { summary?: unknown } | null)?.summary;
  if (typeof s !== "string" || s === "" || /^Would run \S+\. /.test(s)) return `Run ${action}`;
  const first = s.split(/(?<=\.)\s/)[0] ?? s;
  return first.length > CLIP ? `${first.slice(0, CLIP - 1).trimEnd()}…` : first;
}

export async function proposalItems(ctx: ActionContext, limit: number): Promise<AttentionItem[]> {
  const list = await listProposals(ctx, { status: "pending", limit: Math.min(limit, 100) });
  return list.map((p) => ({
    ...BLANK,
    kind: "proposal",
    subject: "proposal",
    id: p.proposalId,
    at: p.createdAt,
    title: proposalSummary(p.action, p.preview),
    detail: p.tokenName,
    provenance: { createdSurface: "mcp", createdByName: null },
    expiresAt: p.expiresAt,
  }));
}

/**
 * The setup checklist is about the organization, so it ignores `ws` (an unknown or stale ?ws= must
 * not send an established org back to "create a workspace"). `ws` narrows only `activeLocations`
 * (which picks Home's layout) and the lost-connection notes.
 */
export async function setupFacts(tx: Tx, actor: Actor, scope: Scope, ws?: string) {
  const [[w], [g], [l], [inWs], rv, pf, relink, [org], [mem], invited, tz] = await Promise.all([
    tx.select({ n }).from(workspaces).where(and(eq(workspaces.orgId, actor.orgId), wsFilter(workspaces.id, scope))),
    tx.select({ n }).from(googleConnections).where(eq(googleConnections.orgId, actor.orgId)),
    tx
      .select({ all: n, active: sql<number>`(count(*) filter (where ${locations.status} = 'active'))::int` })
      .from(locations)
      .where(and(eq(locations.orgId, actor.orgId), wsFilter(locations.workspaceId, scope))),
    tx
      .select({ n })
      .from(locations)
      .where(and(eq(locations.orgId, actor.orgId), eq(locations.status, "active"), wsFilter(locations.workspaceId, scope, ws))),
    tx.select({ id: reviews.id }).from(reviews).innerJoin(locations, eq(locations.id, reviews.locationId)).where(reviewScope(actor)).limit(1),
    tx
      .select({ d: performanceDaily.date })
      .from(performanceDaily)
      .innerJoin(locations, eq(locations.id, performanceDaily.locationId))
      .where(and(eq(locations.orgId, actor.orgId), eq(locations.status, "active"), wsFilter(locations.workspaceId, scope)))
      .limit(1),
    tx
      .select({ workspaceId: locations.workspaceId, workspaceName: workspaces.name, locations: n })
      .from(locations)
      .innerJoin(workspaces, eq(workspaces.id, locations.workspaceId))
      .where(
        and(
          eq(locations.orgId, actor.orgId),
          eq(locations.status, "active"),
          isNull(locations.connectionId),
          isNotNull(locations.googleLocationId),
          wsFilter(locations.workspaceId, scope, ws),
        ),
      )
      .groupBy(locations.workspaceId, workspaces.name)
      .orderBy(workspaces.name),
    tx
      .select({ seen: organizations.healthReportSeenAt, dismissed: organizations.setupDismissedAt })
      .from(organizations)
      .where(eq(organizations.id, actor.orgId)),
    tx.select({ n }).from(memberships).where(eq(memberships.orgId, actor.orgId)),
    invitationCount(tx, actor.orgId),
    tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.orgId, actor.orgId), ne(workspaces.timeZoneSource, "default"), wsFilter(workspaces.id, scope)))
      .limit(1),
  ]);
  return {
    setup: {
      workspaces: w?.n ?? 0,
      googleConnections: g?.n ?? 0,
      locations: l?.all ?? 0,
      activeLocations: l?.active ?? 0,
      hasReviews: rv.length > 0,
      hasPerformance: pf.length > 0,
      healthReportSeen: org?.seen != null,
      setupDismissed: org?.dismissed != null,
      // More than the person who signed up, or an invitation sent (pending counts: the step is "invite", not "they accepted").
      teamInvited: (mem?.n ?? 0) > 1 || invited > 0,
      timeZoneSet: tz.length > 0,
    },
    activeLocations: inWs?.n ?? 0,
    relink,
  };
}

export async function clientRows(
  tx: Tx, actor: Actor, scope: Scope, ws: string | undefined, byWs: Map<string, WorkspaceCounts>, now: Date,
) {
  const thisMonth = monthOf(ymd(now));
  const months = monthsBetween(addMonths(thisMonth, -(CLIENT_TREND_MONTHS - 1)), thisMonth);
  const month = sql<string>`to_char(${reviews.createTime} at time zone 'UTC', 'YYYY-MM')`;
  const [list, ratings, trend] = await Promise.all([
    tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        active: sql<number>`(count(${locations.id}) filter (where ${locations.status} = 'active'))::int`,
      })
      .from(workspaces)
      .leftJoin(locations, eq(locations.workspaceId, workspaces.id))
      .where(and(eq(workspaces.orgId, actor.orgId), wsFilter(workspaces.id, scope, ws)))
      .groupBy(workspaces.id, workspaces.name),
    tx
      .select({ ws: reviews.workspaceId, avg: sql<string | null>`avg(${reviews.starRating})` })
      .from(reviews)
      .innerJoin(locations, eq(locations.id, reviews.locationId))
      .where(reviewScope(actor, ws))
      .groupBy(reviews.workspaceId),
    tx
      .select({ ws: reviews.workspaceId, month, avg: sql<string | null>`avg(${reviews.starRating})` })
      .from(reviews)
      .innerJoin(locations, eq(locations.id, reviews.locationId))
      .where(and(reviewScope(actor, ws), gte(reviews.createTime, new Date(`${monthStart(months[0]!)}T00:00:00Z`))))
      .groupBy(reviews.workspaceId, month),
  ]);
  return list
    .map((w) => ({
      workspaceId: w.id,
      name: w.name,
      activeLocations: w.active,
      averageRating: avg2(ratings.find((r) => r.ws === w.id)?.avg),
      attention: workspaceAttention(byWs.get(w.id)),
      ratingTrend: months.map((m) => avg2(trend.find((t) => t.ws === w.id && t.month === m)?.avg)),
    }))
    .sort((a, b) => b.attention - a.attention || a.name.localeCompare(b.name));
}

export async function ownerCards(tx: Tx, actor: Actor, scope: Scope, ws: string | undefined, now: Date) {
  const locs = await tx
    .select({ id: locations.id, title: locations.title, name: locations.name, addressSummary: locations.addressSummary, workspaceName: workspaces.name })
    .from(locations)
    .innerJoin(workspaces, eq(workspaces.id, locations.workspaceId))
    .where(and(eq(locations.orgId, actor.orgId), eq(locations.status, "active"), wsFilter(locations.workspaceId, scope, ws)))
    .orderBy(asc(locations.title), asc(locations.id))
    .limit(HOME_OWNER_MAX_LOCATIONS);
  const ids = locs.map((l) => l.id);
  if (ids.length === 0) return [];
  const [stats, posted, perf] = await Promise.all([
    locationStats(tx, actor.orgId, ids),
    lastPostDates(tx, ids),
    byLocation(tx, { locationIds: ids, range: last30DaysRange(now) }),
  ]);
  const kpi = (d: { total: number; deltaPct: number | null } | undefined) => ({ total: d?.total ?? 0, deltaPct: d?.deltaPct ?? null });
  return locs.map((l) => {
    const s = stats.find((x) => x.locationId === l.id)!;
    const p = perf.find((x) => x.locationId === l.id);
    return {
      id: l.id,
      title: l.title ?? l.name,
      addressSummary: l.addressSummary,
      workspaceName: l.workspaceName,
      reviews: s.reviews,
      openChanges: s.openChanges,
      suspensionOpen: s.suspensionOpen,
      lastPostAt: posted.get(l.id)?.at.toISOString() ?? null,
      performance: { hasData: p?.lastDataDate != null, calls: kpi(p?.calls), directions: kpi(p?.directions) },
    };
  });
}

export async function autoApproveRules(tx: Tx, actor: Actor, scope: Scope, ws?: string) {
  const rows = await tx
    .select({ workspaceName: workspaces.name, minStars: workspaceReplySettings.autoApproveMinStars })
    .from(workspaceReplySettings)
    .innerJoin(workspaces, eq(workspaces.id, workspaceReplySettings.workspaceId))
    .where(
      and(
        eq(workspaceReplySettings.orgId, actor.orgId),
        isNotNull(workspaceReplySettings.autoApproveMinStars),
        wsFilter(workspaceReplySettings.workspaceId, scope, ws),
      ),
    )
    .orderBy(workspaces.name);
  return rows.map((r) => ({ workspaceName: r.workspaceName, minStars: r.minStars! }));
}

export async function lastReviewSyncAt(tx: Tx, actor: Actor, scope: Scope, ws?: string) {
  const [r] = await tx
    .select({ at: isoUtc(reviewSyncs.finishedAt) })
    .from(reviewSyncs)
    .innerJoin(locations, eq(locations.id, reviewSyncs.locationId))
    .where(and(eq(reviewSyncs.orgId, actor.orgId), eq(reviewSyncs.status, "done"), eq(locations.status, "active"), wsFilter(locations.workspaceId, scope, ws)));
  return r?.at ?? null;
}
