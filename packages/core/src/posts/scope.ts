import { and, desc, eq, gte, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { googlePosts, locations, postTargets, type Db } from "@opengmb/db";

/**
 * F6: the one definition of "the posts of a location or scope", for every consumer (All posts,
 * Calendar, Home, Performance, the location Overview).
 *
 * - A SynGMB post is a `posts` row; it counts where it has a `published` target.
 * - A Google-only post is a `google_posts` mirror row that is live and whose name matches no
 *   `post_targets.google_post_name`. A SynGMB post that is also on Google therefore counts once, as
 *   the SynGMB one, whichever of the two writes happened first.
 */
export type PostReader = Pick<Db, "select">;

/** Live on Google: Google omits state or says LIVE (PROCESSING and REJECTED posts are not posts yet). */
const live = or(isNull(googlePosts.state), eq(googlePosts.state, "LIVE"));
const notMadeHere = sql`not exists (select 1 from ${postTargets} where ${postTargets.googlePostName} = ${googlePosts.googlePostName})`;
const googleOnly = and(live, notMadeHere);

export type GoogleOnlyPost = {
  id: string;
  locationId: string;
  locationName: string;
  workspaceId: string;
  googlePostName: string;
  topicType: string;
  summary: string;
  eventTitle: string | null;
  mediaUrl: string | null;
  searchUrl: string | null;
  ctaType: string | null;
  /** When the post went up on Google. */
  at: string | null;
};

/** Newest first. `workspaceIds` null means every workspace the caller can see. */
export async function googleOnlyPosts(
  q: PostReader,
  p: {
    orgId: string;
    workspaceIds?: string[] | null;
    workspaceId?: string;
    locationIds?: string[];
    topicType?: string;
    text?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  },
): Promise<GoogleOnlyPost[]> {
  if (p.locationIds && p.locationIds.length === 0) return [];
  if (p.workspaceIds && p.workspaceIds.length === 0) return [];
  const rows = await q
    .select({
      id: googlePosts.id,
      locationId: googlePosts.locationId,
      locationName: locations.title,
      fallbackName: locations.name,
      workspaceId: locations.workspaceId,
      googlePostName: googlePosts.googlePostName,
      topicType: googlePosts.topicType,
      summary: googlePosts.summary,
      eventTitle: googlePosts.eventTitle,
      mediaUrl: googlePosts.mediaUrl,
      searchUrl: googlePosts.searchUrl,
      ctaType: googlePosts.ctaType,
      at: googlePosts.googleCreatedAt,
    })
    .from(googlePosts)
    .innerJoin(locations, eq(locations.id, googlePosts.locationId))
    .where(
      and(
        eq(googlePosts.orgId, p.orgId),
        googleOnly,
        p.workspaceIds ? inArray(locations.workspaceId, p.workspaceIds) : undefined,
        p.workspaceId ? eq(locations.workspaceId, p.workspaceId) : undefined,
        p.locationIds ? inArray(googlePosts.locationId, p.locationIds) : undefined,
        p.topicType ? eq(googlePosts.topicType, p.topicType) : undefined,
        p.text ? ilike(googlePosts.summary, `%${p.text.replace(/[\\%_]/g, "\\$&")}%`) : undefined,
        p.from ? gte(googlePosts.googleCreatedAt, p.from) : undefined,
        p.to ? lt(googlePosts.googleCreatedAt, p.to) : undefined,
      ),
    )
    .orderBy(sql`${googlePosts.googleCreatedAt} desc nulls last`, desc(googlePosts.id))
    .limit(p.limit ?? 100);
  return rows.map(({ fallbackName, locationName, at, ...r }) => ({
    ...r,
    locationName: locationName ?? fallbackName,
    at: at ? at.toISOString() : null,
  }));
}

/** Distinct posts published in [start, end) at these locations: SynGMB-made plus Google-only. */
export async function postCount(
  q: PostReader,
  p: { locationIds: string[]; start: Date; end: Date },
): Promise<number> {
  if (p.locationIds.length === 0) return 0;
  const [mine] = await q
    .select({ n: sql<number>`count(distinct ${postTargets.postId})::int` })
    .from(postTargets)
    .where(
      and(
        inArray(postTargets.locationId, p.locationIds),
        gte(postTargets.publishedAt, p.start),
        lt(postTargets.publishedAt, p.end),
      ),
    );
  const [theirs] = await q
    .select({ n: sql<number>`count(*)::int` })
    .from(googlePosts)
    .where(
      and(
        inArray(googlePosts.locationId, p.locationIds),
        googleOnly,
        gte(googlePosts.googleCreatedAt, p.start),
        lt(googlePosts.googleCreatedAt, p.end),
      ),
    );
  return (mine?.n ?? 0) + (theirs?.n ?? 0);
}

/** The latest post date per location (SynGMB published or Google-only); locations with none are absent. */
export async function lastPostDates(
  q: PostReader,
  locationIds: string[],
): Promise<Map<string, { at: Date; source: "syngmb" | "google" }>> {
  const out = new Map<string, { at: Date; source: "syngmb" | "google" }>();
  if (locationIds.length === 0) return out;
  const mine = await q
    .select({ locationId: postTargets.locationId, at: sql<Date>`max(${postTargets.publishedAt})` })
    .from(postTargets)
    .where(and(inArray(postTargets.locationId, locationIds), eq(postTargets.status, "published")))
    .groupBy(postTargets.locationId);
  const theirs = await q
    .select({ locationId: googlePosts.locationId, at: sql<Date>`max(${googlePosts.googleCreatedAt})` })
    .from(googlePosts)
    .where(and(inArray(googlePosts.locationId, locationIds), googleOnly))
    .groupBy(googlePosts.locationId);
  for (const [rows, source] of [
    [mine, "syngmb"],
    [theirs, "google"],
  ] as const) {
    for (const r of rows) {
      if (!r.at) continue;
      const at = new Date(r.at);
      const cur = out.get(r.locationId);
      if (!cur || at > cur.at) out.set(r.locationId, { at, source });
    }
  }
  return out;
}
