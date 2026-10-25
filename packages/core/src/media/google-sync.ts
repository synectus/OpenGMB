import { and, eq, notInArray } from "drizzle-orm";
import { googleMedia, type Db } from "@opengmb/db";
import { MEDIA_LIMITS } from "../config/media-limits";
import type { ListMediaResponse } from "../google/client";

type Lister = {
  listMedia(
    parent: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<ListMediaResponse>;
};

const date = (iso: string | undefined) => {
  const t = iso ? new Date(iso) : null;
  return t && !Number.isNaN(t.getTime()) ? t : null;
};

/**
 * X3a: mirror a location's Google photos into `google_media` (URLs and the fields needed to show
 * them, never bytes). Videos and items without a URL are skipped. Rows for photos Google no longer
 * lists are deleted, unless the read was cut short by the page cap. Google is read first, with no
 * transaction open; the write is one short transaction.
 */
export async function syncGoogleMedia(
  db: Db,
  loc: {
    id: string;
    orgId: string;
    googleAccountName: string | null;
    googleLocationId: string | null;
  },
  client: Lister,
): Promise<{ fetched: number; removed: number; truncated: boolean }> {
  if (!loc.googleAccountName || !loc.googleLocationId)
    return { fetched: 0, removed: 0, truncated: false };
  const parent = `${loc.googleAccountName}/${loc.googleLocationId}`;
  const found = [];
  let pageToken: string | undefined;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page === MEDIA_LIMITS.maxPages) {
      truncated = true;
      break;
    }
    const res = await client.listMedia(parent, {
      pageSize: MEDIA_LIMITS.listPageSize.limit,
      ...(pageToken ? { pageToken } : {}),
    });
    found.push(...res.mediaItems);
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  const photos = found.filter(
    (m): m is typeof m & { name: string; googleUrl: string } =>
      !!m.name && !!m.googleUrl && (m.mediaFormat ?? "PHOTO") === "PHOTO",
  );
  const now = new Date();
  return db.transaction(async (tx) => {
    for (const m of photos) {
      const values = {
        orgId: loc.orgId,
        locationId: loc.id,
        googleMediaName: m.name,
        category: m.locationAssociation?.category ?? null,
        description: m.description ?? null,
        googleUrl: m.googleUrl,
        thumbnailUrl: m.thumbnailUrl ?? null,
        widthPixels: m.dimensions?.widthPixels ?? null,
        heightPixels: m.dimensions?.heightPixels ?? null,
        googleCreatedAt: date(m.createTime),
        syncedAt: now,
      };
      await tx
        .insert(googleMedia)
        .values(values)
        .onConflictDoUpdate({ target: googleMedia.googleMediaName, set: values });
    }
    let removed = 0;
    if (!truncated) {
      const gone = await tx
        .delete(googleMedia)
        .where(
          and(
            eq(googleMedia.locationId, loc.id),
            photos.length
              ? notInArray(
                  googleMedia.googleMediaName,
                  photos.map((m) => m.name),
                )
              : undefined,
          ),
        )
        .returning({ id: googleMedia.id });
      removed = gone.length;
    }
    return { fetched: photos.length, removed, truncated };
  });
}
