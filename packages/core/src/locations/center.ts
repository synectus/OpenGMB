import { and, desc, eq, sql } from "drizzle-orm";
import { gridConfigs, locations, platformDfsSpend, type Db, type Tx } from "@opengmb/db";
import { canonicalJson } from "../audit";
import { dfsLocationCodeFor } from "../config/dfs-locations";
import { LOCATION_CENTER } from "../config/location-center";
import { PlatformCapExceededError, assertWithinPlatformCap } from "../geogrid/cost";
import { dataForSeoBaseUrl, platformDataForSeoCredentials, rankSource } from "../geogrid/drivers/source";
import type { GoogleClient } from "../google/client";
import { getIntegrationFresh } from "../integrations";
import { deferIfBlocked, enqueueJob } from "../jobs";
import { NORMALISE } from "../profile/fields";
import { clientFor } from "../reviews/reply-jobs";
import { sha256, workerAudit } from "../reviews/reply-state";

export const LOCATION_CENTER_QUEUE = "locations.center_resolve";
export const LOCATION_CENTER_QUEUE_OPTIONS = { retryLimit: 2, retryDelay: 120, retryBackoff: true } as const;

export type LocationCenterJob = {
  locationId: string;
  /** Why the job exists; only 'address_changed' and 'onboarding' come from the app, 'backfill' from the CLI. */
  reason: "onboarding" | "address_changed" | "backfill";
};
/**
 * Queue a coordinate lookup from inside another transaction (import, relink, nightly watch). The
 * web app deploys before the worker that creates the queue, so a missing queue must never fail or
 * roll back the caller: the enqueue runs in a savepoint and a failure is logged and swallowed (the
 * backfill picks up any location missed).
 */
export async function tryEnqueueLocationCenter(tx: Tx, job: LocationCenterJob): Promise<void> {
  try {
    await tx.transaction(async (sp) => {
      await enqueueJob(sp, LOCATION_CENTER_QUEUE, job);
    });
  } catch (e) {
    console.warn(`[locations.center] could not queue ${job.reason} lookup for ${job.locationId}: ${e instanceof Error ? e.message : "error"}`);
  }
}

export type CenterSource = "google" | "places" | "dataforseo" | "tracker";
export type Coord = { lat: number; lng: number };
export type CenterOutcome =
  | { outcome: "resolved"; source: CenterSource }
  | { outcome: "unresolved" | "unchanged" | "kept_manual" | "skipped" };

export type PlacesLookup = (q: { placeId: string | null; query: string }) => Promise<Coord | null>;
export type DfsLookup = (placeId: string, locationCode: number) => Promise<(Coord & { costUsd: number | null }) | null>;
export type CenterDeps = {
  client?: Pick<GoogleClient, "getLocation">;
  /** Default: Google Places when GOOGLE_PLACES_SERVER_KEY is set (in-app or env), else no answer. */
  places?: PlacesLookup;
  /** Default: true only when our DataForSEO credentials are set against the live host. */
  dfsEnabled?: () => boolean;
  dfs?: DfsLookup;
  now?: Date;
};

/** Hash of the normalised storefront address, or null when there is none. Whitespace and region case do not change it. */
export function addressHash(storefrontAddress: unknown): string | null {
  const n = NORMALISE.storefrontAddress(storefrontAddress);
  return n ? sha256(canonicalJson(n)) : null;
}

/** The ISO country of a storefront address, or null. */
export function regionCodeOf(storefrontAddress: unknown): string | null {
  const r = (storefrontAddress as { regionCode?: unknown } | null | undefined)?.regionCode;
  return typeof r === "string" && r.trim() ? r.trim().toUpperCase() : null;
}

/** The country of a location per Google (one read), or null when Google cannot be read. */
export async function locationRegionCode(db: Db, loc: { orgId: string; connectionId: string | null; googleLocationId: string | null }, client?: Pick<GoogleClient, "getLocation">): Promise<string | null> {
  if (!loc.googleLocationId) return null;
  try {
    const c = client ?? (await clientFor(db, loc.orgId, loc.connectionId));
    return c ? regionCodeOf((await c.getLocation(loc.googleLocationId, { readMask: "name,storefrontAddress" })).storefrontAddress) : null;
  } catch {
    return null;
  }
}

const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function addressText(title: string | null | undefined, a: unknown): string {
  const x = (a ?? {}) as { addressLines?: string[]; locality?: string; administrativeArea?: string; postalCode?: string; regionCode?: string };
  return [title, ...(x.addressLines ?? []), x.locality, x.administrativeArea, x.postalCode, x.regionCode].filter(Boolean).join(", ");
}

/** Google Places (New): Place Details for a place id, else Text Search on the address. No key, no request. */
export function livePlacesCenter(opts: { key?: () => Promise<string | null | undefined>; fetch?: typeof fetch } = {}): PlacesLookup {
  const cfg = LOCATION_CENTER.places;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const key = opts.key ?? (() => getIntegrationFresh("GOOGLE_PLACES_SERVER_KEY"));
  return async ({ placeId, query }) => {
    const k = (await key())?.trim();
    if (!k) return null;
    const signal = AbortSignal.timeout(LOCATION_CENTER.timeoutMs);
    if (placeId) {
      const res = await doFetch(`${cfg.host}${cfg.detailsPath}${encodeURIComponent(placeId)}`, {
        headers: { "x-goog-api-key": k, "x-goog-fieldmask": cfg.detailsFieldMask },
        signal,
      });
      const j = (await res.json().catch(() => null)) as { location?: { latitude?: number; longitude?: number } } | null;
      const loc = j?.location;
      return res.ok && num(loc?.latitude) && num(loc?.longitude) ? { lat: loc.latitude, lng: loc.longitude } : null;
    }
    if (!query) return null;
    const res = await doFetch(`${cfg.host}${cfg.searchTextPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": k, "x-goog-fieldmask": cfg.searchTextFieldMask },
      body: JSON.stringify({ textQuery: query, pageSize: 1 }),
      signal,
    });
    const j = (await res.json().catch(() => null)) as { places?: { location?: { latitude?: number; longitude?: number } }[] } | null;
    const loc = j?.places?.[0]?.location;
    return res.ok && num(loc?.latitude) && num(loc?.longitude) ? { lat: loc.latitude, lng: loc.longitude } : null;
  };
}

/** DataForSEO Business Data, Google My Business Info (Live), on our key. Never logs or throws the credentials. */
export function liveDfsCenter(opts: { fetch?: typeof fetch } = {}): DfsLookup {
  const cfg = LOCATION_CENTER.dataforseo;
  const doFetch = opts.fetch ?? globalThis.fetch;
  return async (placeId, locationCode) => {
    const creds = await platformDataForSeoCredentials();
    if (!creds) return null;
    const res = await doFetch(`${dataForSeoBaseUrl()}${cfg.path}`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${creds.login}:${creds.password}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify([{ keyword: `${cfg.keywordPrefix}${placeId}`, location_code: locationCode, language_code: cfg.languageCode }]),
      signal: AbortSignal.timeout(LOCATION_CENTER.timeoutMs),
    });
    const j = (await res.json().catch(() => null)) as {
      tasks?: { cost?: number; result?: { items?: { latitude?: number; longitude?: number }[] }[] }[];
    } | null;
    if (!res.ok) return null;
    const task = j?.tasks?.[0];
    const item = task?.result?.[0]?.items?.[0];
    const costUsd = num(task?.cost) ? task.cost : null;
    return num(item?.latitude) && num(item?.longitude) ? { lat: item.latitude, lng: item.longitude, costUsd } : null;
  };
}

/**
 * Resolve and STORE one location's coordinates. Order, stopping at the first hit: Google's latlng;
 * Google Places (only with a key); DataForSEO business data (our key, platform cost, under the daily
 * cap); the location's newest rank-tracker centre. All miss: coordinates stay null. A 'manual' centre
 * is never replaced. A location that already has coordinates for its current address is left alone.
 * Google and the paid APIs are called with no transaction open.
 */
export async function processLocationCenter(db: Db, job: LocationCenterJob, deps: CenterDeps = {}): Promise<CenterOutcome> {
  const now = deps.now ?? new Date();
  const [loc] = await db.select().from(locations).where(eq(locations.id, job.locationId));
  if (!loc || loc.status !== "active") return { outcome: "skipped" };
  if (loc.centerSource === "manual") return { outcome: "kept_manual" };
  // AP3b: this can call paid Places / DataForSEO; a suspended org's job waits (re-queued) instead.
  if (await deferIfBlocked(db, loc.orgId, LOCATION_CENTER_QUEUE, job)) return { outcome: "skipped" };

  let google: Awaited<ReturnType<Pick<GoogleClient, "getLocation">["getLocation"]>> | null = null;
  if (loc.googleLocationId) {
    try {
      const client = deps.client ?? (await clientFor(db, loc.orgId, loc.connectionId));
      google = client ? await client.getLocation(loc.googleLocationId, { readMask: "name,title,latlng,metadata,storefrontAddress" }) : null;
    } catch {
      google = null; // Google unreadable: the remaining sources still run; no address hash is stored
    }
  }
  const hash = google ? addressHash(google.storefrontAddress) : null;
  if (loc.centerLat != null && loc.centerLng != null && hash !== null && loc.centerAddressHash === hash) return { outcome: "unchanged" };

  const rawPlaceId = google?.metadata?.placeId;
  const placeId = rawPlaceId && PLACE_ID.test(rawPlaceId) ? rawPlaceId : null;
  let found: (Coord & { source: CenterSource }) | null = null;

  if (num(google?.latlng?.latitude) && num(google?.latlng?.longitude)) {
    found = { lat: google!.latlng!.latitude, lng: google!.latlng!.longitude, source: "google" };
  }
  if (!found) {
    const query = addressText(google?.title ?? loc.title, google?.storefrontAddress);
    const hit = await (deps.places ?? livePlacesCenter())({ placeId, query }).catch(() => null);
    if (hit) found = { ...hit, source: "places" };
  }
  if (!found && placeId && (deps.dfsEnabled ?? (() => rankSource() === "live"))()) {
    found = await dfsStep(db, loc.id, placeId, deps.dfs ?? liveDfsCenter(), now, dfsLocationCodeFor(regionCodeOf(google?.storefrontAddress)));
  }
  if (!found) {
    const [tracker] = await db
      .select({ lat: gridConfigs.centerLat, lng: gridConfigs.centerLng })
      .from(gridConfigs)
      .where(and(eq(gridConfigs.orgId, loc.orgId), eq(gridConfigs.locationId, loc.id), eq(gridConfigs.kind, "tracker")))
      .orderBy(desc(gridConfigs.updatedAt), desc(gridConfigs.id))
      .limit(1);
    if (tracker) found = { lat: tracker.lat, lng: tracker.lng, source: "tracker" };
  }

  // Nothing found and Google unreadable: write nothing, so a later run can try again.
  if (!found && hash === null) return { outcome: "unresolved" };

  return db.transaction(async (tx): Promise<CenterOutcome> => {
    const [done] = await tx
      .update(locations)
      .set({
        // Every source missed: keep what is stored (the old coordinates are the best we have); the new
        // hash and time are still recorded so the nightly watch does not retry.
        ...(found ? { centerLat: found.lat, centerLng: found.lng, centerSource: found.source } : {}),
        centerAddressHash: hash,
        centerUpdatedAt: now,
      })
      // A manual centre set while this ran must survive.
      .where(and(eq(locations.id, loc.id), sql`${locations.centerSource} is distinct from 'manual'`))
      .returning({ id: locations.id });
    if (!done) return { outcome: "kept_manual" };
    await workerAudit(tx, loc.orgId)({
      action: found ? "location.center_resolved" : "location.center_unresolved",
      entityType: "location",
      entityId: loc.id,
      after: { source: found?.source ?? null, reason: job.reason },
    });
    if (!found) console.warn(`[locations.center] no source could place location ${loc.id} (${job.reason}); stored coordinates kept`);
    return found ? { outcome: "resolved", source: found.source } : { outcome: "unresolved" };
  });
}

/** Reserve the price under the platform's daily cap, call DataForSEO, then settle the recorded cost. */
async function dfsStep(db: Db, locationId: string, placeId: string, lookup: DfsLookup, now: Date, locationCode: number): Promise<(Coord & { source: "dataforseo" }) | null> {
  const price = LOCATION_CENTER.dataforseo.perProfileUsd;
  let spendId: string;
  try {
    spendId = await db.transaction(async (tx) => {
      await assertWithinPlatformCap(tx, price, now);
      const [r] = await tx.insert(platformDfsSpend).values({ kind: "location_center", locationId, costUsd: String(price) }).returning({ id: platformDfsSpend.id });
      return r!.id;
    });
  } catch (e) {
    if (e instanceof PlatformCapExceededError) return null;
    throw e;
  }
  const hit = await lookup(placeId, locationCode).catch(() => null);
  if (hit?.costUsd != null) await db.update(platformDfsSpend).set({ costUsd: String(hit.costUsd) }).where(eq(platformDfsSpend.id, spendId));
  return hit ? { lat: hit.lat, lng: hit.lng, source: "dataforseo" } : null;
}
