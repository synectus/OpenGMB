import { and, eq, notInArray } from "drizzle-orm";
import { googlePosts, type Db } from "@opengmb/db";
import { POST_LIMITS } from "../config/post-limits";
import type { ListLocalPostsResponse } from "../google/client";

type Lister = {
  listLocalPosts(
    parent: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<ListLocalPostsResponse>;
};

const date = (iso: string | undefined) => {
  const t = iso ? new Date(iso) : null;
  return t && !Number.isNaN(t.getTime()) ? t : null;
};

/**
 * Mirror a location's Google posts into `google_posts` (all of them, SynGMB-made too: telling them
 * apart is the reader's job, see posts/scope.ts). Pages like posts.googleList. Rows for posts Google
 * no longer lists are deleted, unless the read was cut short by the page cap. Google is read first,
 * with no transaction open; the write is one short transaction.
 */
export async function syncGooglePosts(
  db: Db,
  loc: { id: string; orgId: string; googleAccountName: string | null; googleLocationId: string | null },
  client: Lister,
): Promise<{ fetched: number; removed: number; truncated: boolean }> {
  if (!loc.googleAccountName || !loc.googleLocationId) return { fetched: 0, removed: 0, truncated: false };
  const parent = `${loc.googleAccountName}/${loc.googleLocationId}`;
  const found = [];
  let pageToken: string | undefined;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page === POST_LIMITS.listMaxPages) {
      truncated = true;
      break;
    }
    const res = await client.listLocalPosts(parent, {
      pageSize: POST_LIMITS.listPageSize.limit,
      ...(pageToken ? { pageToken } : {}),
    });
    found.push(...res.localPosts);
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  const named = found.filter((p): p is typeof p & { name: string } => !!p.name);
  const now = new Date();
  return db.transaction(async (tx) => {
    for (const p of named) {
      const values = {
        orgId: loc.orgId,
        locationId: loc.id,
        googlePostName: p.name,
        topicType: p.topicType,
        state: p.state ?? null,
        summary: p.summary ?? "",
        eventTitle: p.event?.title ?? null,
        mediaUrl: p.media?.[0]?.googleUrl ?? p.media?.[0]?.sourceUrl ?? null,
        searchUrl: p.searchUrl ?? null,
        ctaType: p.callToAction?.actionType ?? null,
        ctaUrl: p.callToAction?.url ?? null,
        googleCreatedAt: date(p.createTime),
        googleUpdatedAt: date(p.updateTime),
        syncedAt: now,
      };
      await tx
        .insert(googlePosts)
        .values(values)
        .onConflictDoUpdate({ target: googlePosts.googlePostName, set: values });
    }
    let removed = 0;
    if (!truncated) {
      const gone = await tx
        .delete(googlePosts)
        .where(
          and(
            eq(googlePosts.locationId, loc.id),
            named.length ? notInArray(googlePosts.googlePostName, named.map((p) => p.name)) : undefined,
          ),
        )
        .returning({ id: googlePosts.id });
      removed = gone.length;
    }
    return { fetched: named.length, removed, truncated };
  });
}
