import { useAccountDaily } from "../limits/counters";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { locations, reviewReplies, reviewSyncs, workspaces } from "@opengmb/db";
import { OPEN_STATUSES } from "../reviews/reply-state";
import { AccessError, authorize, workspaceScope } from "../actor";
import { CoreError } from "../errors";
import { roleHasPermission } from "../permissions";
import { defineAction } from "../registry";
import { replyPolicy } from "../reviews/reply-policy";
import {
  encodeCursor,
  getReviewRow,
  queryReviews,
  REVIEW_SORTS,
  reviewItemOut,
  toReviewItem,
  type ReviewFilters,
} from "../reviews/queries";
import { REVIEWS_CONFIG } from "../config/reviews";
import { REVIEW_TOPIC_IDS, TOPIC_SENTIMENTS } from "../config/review-topics";
import { EXPORT_COLUMNS, reviewsToCsv } from "../reviews/export";
import { requestReviewSync } from "../reviews/sync";
import {
  getWorkspaceReplySettings,
  type WorkspaceReplySettings,
} from "../reviews/workspace-settings";

const isoDate = z.iso.datetime({ offset: true });

export const reviewsSync = defineAction({
  name: "reviews.sync",
  description:
    "Request a review sync from Google for the active locations of a workspace (or just locationIds in it). Asynchronous: records one review_syncs row per location, audits it and queues a worker job per location in the same transaction; poll reviews.syncStatus with the returned syncIds. Inactive or unknown locations are listed in skipped. Replies made directly in Google are picked up too.",
  input: z.object({
    workspaceId: z.uuid(),
    locationIds: z.array(z.uuid()).min(1).max(100).optional(),
  }),
  output: z.object({
    syncs: z.array(z.object({ syncId: z.string(), locationId: z.string(), jobId: z.string() })),
    skipped: z.array(z.object({ locationId: z.string(), reason: z.string() })),
  }),
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "review:draft", { workspaceId: input.workspaceId });
    const [w] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.orgId, actor.orgId)));
    if (!w) throw new AccessError("NOT_FOUND", "Workspace not found");

    const inWorkspace = await tx
      .select({ id: locations.id, status: locations.status })
      .from(locations)
      .where(
        and(
          eq(locations.orgId, actor.orgId),
          eq(locations.workspaceId, input.workspaceId),
          input.locationIds ? inArray(locations.id, input.locationIds) : undefined,
        ),
      );
    const active = inWorkspace.filter((l) => l.status === "active");
    const skipped = input.locationIds
      ? [...new Set(input.locationIds)]
          .filter((id) => !active.some((l) => l.id === id))
          .map((locationId) => ({
            locationId,
            reason: inWorkspace.some((l) => l.id === locationId) ? "inactive" : "not_found",
          }))
      : [];
    if (active.length === 0) throw new CoreError("NOT_FOUND", "No active locations to sync");

    await useAccountDaily(tx, actor.orgId, "google_sync", active.length);
    const syncs = [];
    for (const l of active.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const { syncId, jobId } = await requestReviewSync(tx, {
        orgId: actor.orgId,
        locationId: l.id,
        requestedBy: actor.userId,
        audit,
        reason: { trigger: "manual", workspaceId: input.workspaceId },
      });
      syncs.push({ syncId, locationId: l.id, jobId });
    }
    return { syncs, skipped };
  },
});

const listInput = z.object({
  workspaceId: z.uuid().optional(),
  locationIds: z.array(z.uuid()).min(1).max(100).optional(),
  groupId: z.uuid().optional(),
  ratings: z.array(z.number().int().min(1).max(5)).min(1).max(5).optional(),
  replied: z.boolean().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  topic: z.enum(REVIEW_TOPIC_IDS).optional(),
  sentiment: z.enum(TOPIC_SENTIMENTS).optional(),
  sort: z.enum(REVIEW_SORTS).default("newest"),
  cursor: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export const reviewsList = defineAction({
  name: "reviews.list",
  description:
    "List Google reviews for active locations the caller can see. Order: sort newest (default; create time, then id), oldest, rating_high (5 stars first) or rating_low (1 star first); unrated reviews come last in both rating sorts and ties go newest first. Search: q finds reviews whose text or reviewer name contains the phrase (case-insensitive, matched literally, so % and _ are ordinary characters; an anonymous reviewer's name is not searched). Filters: workspaceId, locationIds, groupId, ratings (1-5), replied (true = Google shows a reply; false = the review needs you: no visible reply and no reply waiting for approval or publish, or a reply that is blocked or failed, with the workspace reply policy applied), from (inclusive) and to (exclusive) as ISO datetimes on the review's create time (UTC), topic (one of the ids reviews.classifyTopics uses: staff, wait_time, price_value, cleanliness, results_quality, communication, booking, location_parking, other) and sentiment (positive, negative or mixed: that topic's sentiment when topic is set, otherwise the review's overall sentiment); these two only match reviews already classified and not edited since. limit 1-100 (default 25); pass nextCursor as cursor for the next page. Client roles only see their own workspaces.",
  input: listInput.extend({
    assignedToMe: z.boolean().optional(),
    overdue: z.boolean().optional(),
  }),
  output: z.object({ items: z.array(reviewItemOut), nextCursor: z.string().nullable() }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    // Assignments are internal: a client role asking about them is refused, not answered with nothing.
    if ((input.assignedToMe || input.overdue) && !roleHasPermission(actor.role, "review:draft")) {
      throw new AccessError("FORBIDDEN", "Assignments are only visible to the team");
    }
    const filters: ReviewFilters = {
      ...listFilters(input),
      assignedToUserId: input.assignedToMe ? actor.userId : undefined,
      overdue: input.overdue || undefined,
    };
    const rows = await queryReviews(tx, actor, filters, {
      limit: input.limit + 1,
      cursor: input.cursor,
      sort: input.sort,
    });
    const page = rows.slice(0, input.limit);
    return {
      items: page.map(toReviewItem),
      nextCursor: rows.length > input.limit ? encodeCursor(page[page.length - 1]!, input.sort) : null,
    };
  },
});

const exportInput = listInput
  .omit({ cursor: true, limit: true })
  .extend({ columns: z.array(z.enum(EXPORT_COLUMNS)).min(1).optional() });

function listFilters(input: z.infer<typeof exportInput>): ReviewFilters {
  return {
    workspaceId: input.workspaceId,
    locationIds: input.locationIds,
    groupId: input.groupId,
    ratings: input.ratings,
    replied: input.replied,
    from: input.from ? new Date(input.from) : undefined,
    to: input.to ? new Date(input.to) : undefined,
    q: input.q,
    topic: input.topic,
    sentiment: input.sentiment,
  };
}

export const reviewsExport = defineAction({
  name: "reviews.export",
  description:
    "Export reviews as a CSV spreadsheet (UTF-8 with BOM, CRLF lines), newest first unless sort says otherwise, with the same filters, search (q), sort and visibility as reviews.list (workspaceId, locationIds, groupId, ratings, replied, from, to, q, sort; no paging). Columns: review date (UTC), location, stars, reviewer (Anonymous when hidden), review text, reply text, reply date, Google reply state, needs reply (yes/no, the same rule as the replied=false filter). Optional columns picks which columns to write (date, location, stars, reviewer, review, reply, replyDate, replyState, needsReply); they are written in that order; omitted means all nine. Leave out reviewer and review to export counts and ratings only. Capped at a fixed row maximum: truncated is true when more matched, so narrow the filters. Review text can contain patient details: the export is audited (reviews.exported) with filters and row count only, never the text.",
  input: exportInput,
  output: z.object({
    filename: z.string(),
    csv: z.string(),
    rowCount: z.number().int(),
    truncated: z.boolean(),
  }),
  permission: "review:read",
  // Kind stays "read": no tenant data changes. Like audit.export, the handler records the export itself.
  kind: "read",
  async handler({ tx, actor, audit }, input) {
    const max = REVIEWS_CONFIG.exportMaxRows;
    const rows = await queryReviews(tx, actor, listFilters(input), { limit: max + 1, sort: input.sort });
    const truncated = rows.length > max;
    const page = truncated ? rows.slice(0, max) : rows;
    await audit({
      action: "reviews.exported",
      entityType: "reviews",
      entityId: actor.orgId,
      after: {
        workspaceId: input.workspaceId ?? null,
        locationIds: input.locationIds ?? null,
        groupId: input.groupId ?? null,
        ratings: input.ratings ?? null,
        replied: input.replied ?? null,
        from: input.from ?? null,
        to: input.to ?? null,
        searched: input.q !== undefined,
        topic: input.topic ?? null,
        sentiment: input.sentiment ?? null,
        sort: input.sort,
        columns: input.columns ?? null,
        rowCount: page.length,
        truncated,
      },
    });
    return {
      filename: `reviews-${new Date().toISOString().slice(0, 10)}.csv`,
      csv: reviewsToCsv(page, input.columns),
      rowCount: page.length,
      truncated,
    };
  },
});

export const reviewsGet = defineAction({
  name: "reviews.get",
  description:
    "Get one review by id, with its current Google reply. Only reviews at active locations in the caller's workspaces are visible; anything else is NOT_FOUND.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ review: reviewItemOut }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const row = await getReviewRow(tx, actor, input.id);
    if (!row) throw new AccessError("NOT_FOUND", "Review not found");
    return { review: toReviewItem(row) };
  },
});

const unrepliedItem = reviewItemOut.extend({
  replyAllowed: z.boolean(),
  skipReason: z.string().nullable(),
  /** The open reply revision (draft, pending approval, approved, blocked, failed), if any. A new draft would be CONFLICT. */
  openReply: z.object({ id: z.string(), status: z.string() }).nullable(),
});

/** Rows fetched from the database per round trip while skipping disallowed reviews. */
const UNREPLIED_BATCH = 200;

export const reviewsListUnreplied = defineAction({
  name: "reviews.list_unreplied",
  description:
    "Bulk list of reviews with no visible Google reply (none, or one Google rejected), across every active location the caller can see, newest first (create time, then id). Optional filters: workspaceId, locationIds, ratings (1-5). Each item carries replyAllowed and skipReason (from the reply policy, e.g. reviews that must not be answered, or a reply already in progress) and openReply (the open draft or pending reply, if any) so you do not draft replies that will be blocked or refused; skipped items are left out unless includeSkipped is true. limit 1-200 (default 100); pass nextCursor as cursor for the next page. totalReturned is the number of items in this response, not a total.",
  input: z.object({
    workspaceId: z.uuid().optional(),
    locationIds: z.array(z.uuid()).min(1).max(100).optional(),
    ratings: z.array(z.number().int().min(1).max(5)).min(1).max(5).optional(),
    includeSkipped: z.boolean().default(false),
    cursor: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(200).default(100),
  }),
  output: z.object({
    items: z.array(unrepliedItem),
    totalReturned: z.number().int(),
    nextCursor: z.string().nullable(),
  }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const items: z.input<typeof unrepliedItem>[] = [];
    let cursor = input.cursor;
    let nextCursor: string | null = null;
    const settingsByWorkspace = new Map<string, WorkspaceReplySettings>();
    const filters: ReviewFilters = {
      noVisibleReply: true,
      workspaceId: input.workspaceId,
      locationIds: input.locationIds,
      ratings: input.ratings,
    };
    for (;;) {
      const rows = await queryReviews(tx, actor, filters, { limit: UNREPLIED_BATCH, cursor });
      const openRows = rows.length
        ? await tx
            .select({
              id: reviewReplies.id,
              reviewId: reviewReplies.reviewId,
              status: reviewReplies.status,
            })
            .from(reviewReplies)
            .where(
              and(
                inArray(
                  reviewReplies.reviewId,
                  rows.map((r) => r.id),
                ),
                inArray(reviewReplies.status, OPEN_STATUSES),
              ),
            )
        : [];
      const openByReview = new Map(openRows.map((o) => [o.reviewId, { id: o.id, status: o.status }]));
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        let settings = settingsByWorkspace.get(r.workspaceId);
        if (!settings) {
          settings = await getWorkspaceReplySettings(tx, r.workspaceId);
          settingsByWorkspace.set(r.workspaceId, settings);
        }
        const openReply = openByReview.get(r.id) ?? null;
        const byPolicy = replyPolicy({ starRating: r.starRating, comment: r.comment }, settings);
        const policy =
          byPolicy.replyAllowed && openReply
            ? {
                replyAllowed: false,
                skipReason: `A reply is already in progress (${openReply.status.replaceAll("_", " ")}): open it in the Inbox`,
              }
            : byPolicy;
        if (!policy.replyAllowed && !input.includeSkipped) continue;
        if (items.length === input.limit) {
          // One more qualifying row exists, so there is a next page that starts after the last item.
          nextCursor = encodeCursor({
            createTime: new Date(items[items.length - 1]!.createTime),
            id: items[items.length - 1]!.id,
          });
          break;
        }
        items.push({ ...toReviewItem(r), ...policy, openReply });
      }
      if (nextCursor !== null || rows.length < UNREPLIED_BATCH) break;
      const last = rows[rows.length - 1]!;
      cursor = encodeCursor(last);
    }
    return { items, totalReturned: items.length, nextCursor };
  },
});

export const reviewsSyncStatus = defineAction({
  name: "reviews.syncStatus",
  description:
    "Status of review syncs started with reviews.sync: pending, done (with counts fetched/inserted/updated) or failed (with an error). Only syncs for locations in the caller's workspaces are returned; unknown ids are omitted.",
  input: z.object({ syncIds: z.array(z.uuid()).min(1).max(100) }),
  output: z.object({
    syncs: z.array(
      z.object({
        id: z.string(),
        locationId: z.string(),
        locationName: z.string(),
        status: z.enum(["pending", "done", "failed"]),
        counts: z
          .object({
            fetched: z.number().int(),
            inserted: z.number().int(),
            updated: z.number().int(),
            truncated: z.boolean(),
          })
          .nullable(),
        error: z.string().nullable(),
        createdAt: z.string(),
        finishedAt: z.string().nullable(),
      }),
    ),
  }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const scope = workspaceScope(actor);
    const rows = await tx
      .select({ s: reviewSyncs, locationName: locations.name })
      .from(reviewSyncs)
      .innerJoin(locations, eq(locations.id, reviewSyncs.locationId))
      .where(
        and(
          eq(reviewSyncs.orgId, actor.orgId),
          inArray(reviewSyncs.id, input.syncIds),
          scope === "all" ? undefined : inArray(locations.workspaceId, scope),
        ),
      );
    return {
      syncs: rows.map(({ s, locationName }) => ({
        id: s.id,
        locationId: s.locationId,
        locationName,
        status: s.status,
        counts: s.status === "done" ? ((s.counts as never) ?? null) : null,
        error: s.error,
        createdAt: s.createdAt.toISOString(),
        finishedAt: s.finishedAt?.toISOString() ?? null,
      })),
    };
  },
});
