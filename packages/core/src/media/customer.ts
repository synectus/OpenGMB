import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  customerMediaScans,
  customerMediaSeen,
  locations,
  notifications,
  type Db,
} from "@opengmb/db";
import { MEDIA_LIMITS } from "../config/media-limits";
import type { GoogleClient, GoogleMediaItem } from "../google/client";
import { enqueueJob } from "../jobs";
import { orgStagger } from "../google/rate-limit-retry";
import { clientFor } from "../reviews/reply-jobs";
import { workerAudit } from "../reviews/reply-state";
import { recipientsForLocation } from "../notifications";
import { orgIsActive } from "../account-state";

export const CUSTOMER_MEDIA_SCAN_QUEUE = "media.customer_scan";
export const CUSTOMER_MEDIA_SCHEDULE_QUEUE = "media.customer_schedule";
export const CUSTOMER_MEDIA_QUEUE_OPTIONS = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
} as const;
export const MEDIA_CUSTOMER_PHOTO_KIND = "media.customer_photo";

export type CustomerMediaScanJob = { locationId: string; rlAttempt?: number };
type Reader = Pick<GoogleClient, "listCustomerMedia">;

/** All customer media of a location (bounded by MEDIA_LIMITS.maxPages pages of customerPageSize). */
export async function listAllCustomerMedia(
  client: Reader,
  parent: string,
): Promise<GoogleMediaItem[]> {
  const out: GoogleMediaItem[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MEDIA_LIMITS.maxPages; page++) {
    const res = await client.listCustomerMedia(parent, {
      pageSize: MEDIA_LIMITS.customerPageSize.limit,
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...res.mediaItems);
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return out;
}

/** Queue one scan job per active, Google-linked location. Run nightly by the schedule queue. */
export async function enqueueCustomerMediaScans(
  db: Db,
  /** Tests: limit the fan-out to one organization (the shared test database holds many). */
  scope: { orgId?: string } = {},
): Promise<{ enqueued: number }> {
  const rows = await db
    .select({ id: locations.id, orgId: locations.orgId })
    .from(locations)
    .where(
      and(
        eq(locations.status, "active"),
        scope.orgId ? eq(locations.orgId, scope.orgId) : undefined,
        isNotNull(locations.googleLocationId),
        isNotNull(locations.googleAccountName),
        isNotNull(locations.connectionId),
        orgIsActive(locations.orgId),
      ),
    );
  // One transaction: the fan-out is all-or-nothing and a thousand locations stay one round of commits.
  await db.transaction(async (tx) => {
    const stagger = orgStagger();
    for (const r of rows) await enqueueJob(tx, CUSTOMER_MEDIA_SCAN_QUEUE, { locationId: r.id }, { startAfterSeconds: stagger(r.orgId) });
  });
  return { enqueued: rows.length };
}

export type CustomerMediaScanOutcome = {
  status: "skipped" | "baseline" | "scanned";
  newPhotos: number;
};

/**
 * Nightly customer-photo monitoring for one location. Google is read first (no transaction); then
 * one short transaction (serialised per location) records the resource names not seen before. The
 * FIRST scan of a location only records what is already there (a baseline: otherwise every
 * existing photo would alert once); after that every new photo creates one `media.customer_photo`
 * notification per member who can see the location, keyed by the media name so a re-run cannot
 * alert twice. The notification links to the media page; it carries the location name only, never
 * the image or the contributor's name.
 */
export async function processCustomerMediaScan(
  db: Db,
  job: CustomerMediaScanJob,
  deps: { client?: Reader } = {},
): Promise<CustomerMediaScanOutcome> {
  const skipped = { status: "skipped", newPhotos: 0 } as const;
  const [loc] = await db.select().from(locations).where(eq(locations.id, job.locationId));
  if (!loc || loc.status !== "active" || !loc.googleLocationId || !loc.googleAccountName) {
    return skipped;
  }
  const client = deps.client ?? (await clientFor(db, loc.orgId, loc.connectionId));
  if (!client) return skipped;
  const items = await listAllCustomerMedia(
    client,
    `${loc.googleAccountName}/${loc.googleLocationId}`,
  );
  const names = [...new Set(items.flatMap((i) => (i.name ? [i.name] : [])))];

  return db.transaction(async (tx): Promise<CustomerMediaScanOutcome> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${loc.id}::text, 2))`);
    const [scan] = await tx
      .select()
      .from(customerMediaScans)
      .where(eq(customerMediaScans.locationId, loc.id));
    const baseline = !scan;
    const known = names.length
      ? new Set(
          (
            await tx
              .select({ n: customerMediaSeen.mediaName })
              .from(customerMediaSeen)
              .where(
                and(
                  eq(customerMediaSeen.locationId, loc.id),
                  inArray(customerMediaSeen.mediaName, names),
                ),
              )
          ).map((r) => r.n),
        )
      : new Set<string>();
    const fresh = names.filter((n) => !known.has(n));
    const now = new Date();
    for (let i = 0; i < fresh.length; i += 500) {
      await tx
        .insert(customerMediaSeen)
        .values(
          fresh.slice(i, i + 500).map((mediaName) => ({
            orgId: loc.orgId,
            locationId: loc.id,
            mediaName,
            notifiedAt: baseline ? null : now,
          })),
        )
        .onConflictDoNothing();
    }
    await tx
      .insert(customerMediaScans)
      .values({ locationId: loc.id, orgId: loc.orgId, lastRunAt: now })
      .onConflictDoUpdate({ target: customerMediaScans.locationId, set: { lastRunAt: now } });
    if (baseline) return { status: "baseline", newPhotos: 0 };
    if (fresh.length === 0) return { status: "scanned", newPhotos: 0 };

    const recipients = await recipientsForLocation(tx, loc.orgId, loc.id);
    if (recipients.length > 0) {
      for (let i = 0; i < fresh.length; i += 200) {
        await tx
          .insert(notifications)
          .values(
            fresh.slice(i, i + 200).flatMap((mediaName) =>
              recipients.map((userId) => ({
                orgId: loc.orgId,
                userId,
                kind: MEDIA_CUSTOMER_PHOTO_KIND,
                title: `New customer photo at ${loc.title || loc.name}`,
                link: `/locations/${loc.id}/media`,
                sourceType: "customer_media",
                sourceId: mediaName,
              })),
            ),
          )
          .onConflictDoNothing({
            target: [notifications.userId, notifications.sourceType, notifications.sourceId],
          });
      }
    }
    await workerAudit(
      tx,
      loc.orgId,
    )({
      action: "media.customer_photos_detected",
      entityType: "location",
      entityId: loc.id,
      after: { newPhotos: fresh.length, recipientCount: recipients.length },
    });
    return { status: "scanned", newPhotos: fresh.length };
  });
}
