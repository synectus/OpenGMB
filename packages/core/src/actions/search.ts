import { and, desc, eq, exists, inArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { locationGroupMembers, locations, postTargets, posts, reviews } from "@opengmb/db";
import { authorize, workspaceScope } from "../actor";
import { defineAction } from "../registry";
import { locationScope } from "./locations";
import { escapeLike } from "../reviews/queries";

/** Reviews and posts are matched with a trigram index, which needs three characters to help. */
export const SEARCH_TEXT_MIN = 3;

const snippet = (s: string | null) => (s && s.length > 160 ? `${s.slice(0, 157)}...` : s);

export const searchEverything = defineAction({
  name: "search.everything",
  description:
    "Search locations (name, title, address), review text (and the reviewer's name unless anonymous) and post text in one call, for the ⌘K box. q is matched literally, case-insensitively. Reviews and posts are only searched from 3 characters (locations from 1), so a short q returns locations only. Returns at most limitPerKind (1-10, default 5) of each kind, newest first for reviews and posts. Scope with workspaceId, groupId or locationIds, the same as reviews.list; client roles only see their own workspaces. Reviews are active locations only. Internal notes and assignments are never searched or returned.",
  input: z.object({
    q: z.string().trim().min(1).max(100),
    workspaceId: z.uuid().optional(),
    groupId: z.uuid().optional(),
    locationIds: z.array(z.uuid()).min(1).max(500).optional(),
    limitPerKind: z.number().int().min(1).max(10).default(5),
  }),
  output: z.object({
    locations: z.array(
      z.object({
        id: z.string(),
        workspaceId: z.string(),
        name: z.string(),
        title: z.string().nullable(),
        addressSummary: z.string().nullable(),
        status: z.string(),
      }),
    ),
    reviews: z.array(
      z.object({
        id: z.string(),
        workspaceId: z.string(),
        locationId: z.string(),
        locationName: z.string(),
        reviewer: z.string().nullable(),
        rating: z.number().int().nullable(),
        snippet: z.string().nullable(),
        createTime: z.string(),
      }),
    ),
    posts: z.array(
      z.object({
        id: z.string(),
        workspaceId: z.string(),
        status: z.string(),
        snippet: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "review:read", { workspaceId: input.workspaceId });
    const pattern = `%${escapeLike(input.q)}%`;
    const like = (col: AnyPgColumn | SQL) => sql`${col} ilike ${pattern} escape '\\'`;
    const scope = workspaceScope(actor);
    // Which locations are in play: explicit ids, or a group's members.
    const locFilter = (col: AnyPgColumn) => [
      input.locationIds ? inArray(col, input.locationIds) : undefined,
      input.groupId
        ? sql`${col} in (select ${locationGroupMembers.locationId} from ${locationGroupMembers} where ${locationGroupMembers.groupId} = ${input.groupId} and ${locationGroupMembers.orgId} = ${actor.orgId})`
        : undefined,
    ];

    const locRows = await tx
      .select()
      .from(locations)
      .where(
        and(
          locationScope(actor),
          input.workspaceId ? eq(locations.workspaceId, input.workspaceId) : undefined,
          ...locFilter(locations.id),
          sql`(${like(locations.name)} or ${like(sql`coalesce(${locations.title}, '')`)} or ${like(sql`coalesce(${locations.addressSummary}, '')`)})`,
        ),
      )
      .orderBy(sql`${locations.status} = 'active' desc`, locations.name, locations.id)
      .limit(input.limitPerKind);

    const long = input.q.length >= SEARCH_TEXT_MIN;
    const reviewRows = long
      ? await tx
          .select({
            id: reviews.id,
            workspaceId: reviews.workspaceId,
            locationId: reviews.locationId,
            locationName: locations.name,
            reviewer: sql<string | null>`case when ${reviews.reviewerIsAnonymous} then null else ${reviews.reviewerDisplayName} end`,
            rating: reviews.starRating,
            comment: reviews.comment,
            createTime: reviews.createTime,
          })
          .from(reviews)
          .innerJoin(locations, eq(locations.id, reviews.locationId))
          .where(
            and(
              eq(reviews.orgId, actor.orgId),
              eq(locations.orgId, actor.orgId),
              eq(locations.status, "active"),
              scope === "all" ? undefined : inArray(reviews.workspaceId, scope),
              input.workspaceId ? eq(reviews.workspaceId, input.workspaceId) : undefined,
              ...locFilter(reviews.locationId),
              sql`(${like(reviews.comment)} or (not ${reviews.reviewerIsAnonymous} and ${like(reviews.reviewerDisplayName)}))`,
            ),
          )
          .orderBy(desc(reviews.createTime), desc(reviews.id))
          .limit(input.limitPerKind)
      : [];

    const postRows = long
      ? await tx
          .select({
            id: posts.id,
            workspaceId: posts.workspaceId,
            status: posts.status,
            summary: posts.summary,
            createdAt: posts.createdAt,
          })
          .from(posts)
          .where(
            and(
              eq(posts.orgId, actor.orgId),
              scope === "all" ? undefined : inArray(posts.workspaceId, scope),
              input.workspaceId ? eq(posts.workspaceId, input.workspaceId) : undefined,
              input.locationIds || input.groupId
                ? exists(
                    tx
                      .select({ one: sql`1` })
                      .from(postTargets)
                      .where(and(eq(postTargets.postId, posts.id), ...locFilter(postTargets.locationId))),
                  )
                : undefined,
              like(posts.summary),
            ),
          )
          .orderBy(desc(posts.createdAt), desc(posts.id))
          .limit(input.limitPerKind)
      : [];

    return {
      locations: locRows.map((l) => ({
        id: l.id,
        workspaceId: l.workspaceId,
        name: l.name,
        title: l.title,
        addressSummary: l.addressSummary,
        status: l.status,
      })),
      reviews: reviewRows.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        locationId: r.locationId,
        locationName: r.locationName,
        reviewer: r.reviewer,
        rating: r.rating,
        snippet: snippet(r.comment),
        createTime: r.createTime.toISOString(),
      })),
      posts: postRows.map((p) => ({
        id: p.id,
        workspaceId: p.workspaceId,
        status: p.status,
        snippet: snippet(p.summary) ?? "",
        createdAt: p.createdAt.toISOString(),
      })),
    };
  },
});
