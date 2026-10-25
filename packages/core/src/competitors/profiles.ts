import { COMPETITOR_PROFILES, PROFILE_PROVIDER_USD } from "../config/competitor-profiles";
import { DFS_ERROR_CLASSES } from "../config/geogrid";
import { roundUpUsd } from "../geogrid/cost";
import { DfsAccountError, DfsHttpError, DfsRetryableError } from "../geogrid/drivers/errors";
import { dataForSeoBaseUrl, platformDataForSeoCredentials } from "../geogrid/drivers/source";
import type { CompetitorRow } from "../geogrid/analytics";

export type ProfileKind = "info" | "updates";

/** What one competitor's stored profile holds. */
export type ProfileData = {
  /** Primary category first, then the additional ones. */
  categories: { primary: string | null; additional: string[]; ids: string[] };
  totalPhotos: number | null;
  rating: number | null;
  reviewCount: number | null;
  /** The newest of the (up to depth) updates DataForSEO returned; null = none found. */
  lastPostAt: Date | null;
  /** How many of the most recent updates were returned (capped at the requested depth). Not a lifetime total. */
  postsCount: number | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);

type InfoItem = {
  type?: string;
  category?: string | null;
  additional_categories?: string[] | null;
  category_ids?: string[] | null;
  total_photos?: number | null;
  rating?: { value?: number | null; votes_count?: number | null } | null;
};

/** tasks[0].result[0].items[0] of a my_business_info task_get. Null when the business was not found. */
export function parseInfoItem(item: unknown): Pick<ProfileData, "categories" | "totalPhotos" | "rating" | "reviewCount"> | null {
  const i = item as InfoItem | null | undefined;
  if (!i || typeof i !== "object") return null;
  return {
    categories: { primary: typeof i.category === "string" && i.category.trim() ? i.category.trim() : null, additional: strings(i.additional_categories), ids: strings(i.category_ids) },
    totalPhotos: num(i.total_photos),
    rating: num(i.rating?.value),
    reviewCount: num(i.rating?.votes_count),
  };
}

/** DataForSEO timestamp "yyyy-mm-dd hh:mm:ss +00:00" (UTC) -> Date; null when it does not parse. */
export function parseDfsTimestamp(ts: unknown): Date | null {
  if (typeof ts !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}[:-]\d{2}[:-]\d{2})\s*\+00:00$/.exec(ts.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]!.replaceAll("-", ":")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** tasks[0].result[0] of a my_business_updates task_get: the newest post time and how many were returned. */
export function parseUpdatesResult(result: unknown): Pick<ProfileData, "lastPostAt" | "postsCount"> {
  const r = result as { items?: { type?: string; timestamp?: string }[] | null; items_count?: number } | null | undefined;
  const items = (r?.items ?? []).filter((x) => x?.type === "google_business_post");
  const times = items.map((x) => parseDfsTimestamp(x.timestamp)).filter((d): d is Date => d !== null);
  return {
    lastPostAt: times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null,
    postsCount: items.length,
  };
}

/** What the profile refresh of `profiles` businesses costs the customer: provider cost x (1 + markup), rounded up. */
export function refreshCostUsd(profiles: number, markupPercent: number): number {
  return roundUpUsd(profiles * PROFILE_PROVIDER_USD * (1 + markupPercent / 100));
}

/** The most one tracker's weekly refresh can cost (every one of the top competitors has a place id). */
export function weeklyRefreshEstimateUsd(markupPercent: number): number {
  return refreshCostUsd(COMPETITOR_PROFILES.topPerTracker, markupPercent);
}

export type TopCompetitor = { placeId: string; title: string; appearances: number };

/**
 * The top competitors of one tracker: appearances summed over its keywords' latest runs, most first,
 * capped. Businesses without a place id cannot be fetched or matched across days: they are skipped
 * but counted (`skippedNoPlaceId`, among the candidates that made the cut).
 */
export function selectTopCompetitors(
  perKeyword: readonly (readonly CompetitorRow[])[],
  cap: number = COMPETITOR_PROFILES.topPerTracker,
): { top: TopCompetitor[]; skippedNoPlaceId: number } {
  const acc = new Map<string, { placeId: string | null; title: string; appearances: number }>();
  for (const rows of perKeyword) {
    for (const r of rows) {
      if (r.isTarget) continue;
      const key = r.placeId ?? `t:${r.business.trim().toLowerCase()}`;
      const cur = acc.get(key) ?? { placeId: r.placeId, title: r.business, appearances: 0 };
      cur.appearances += r.appearances;
      acc.set(key, cur);
    }
  }
  const ranked = [...acc.values()].sort((a, b) => b.appearances - a.appearances || a.title.localeCompare(b.title)).slice(0, cap);
  return {
    top: ranked.flatMap((c) => (c.placeId ? [{ placeId: c.placeId, title: c.title, appearances: c.appearances }] : [])),
    skippedNoPlaceId: ranked.filter((c) => !c.placeId).length,
  };
}

export type StoredProfile = {
  categories: { primary: string | null; additional: string[]; ids: string[] };
  totalPhotos: number | null;
  rating: number | null;
  reviewCount: number | null;
  lastPostAt: Date | null;
  postsCount: number | null;
};

export type CompetitorProfileChange = {
  photosAdded: number | null;
  reviewsAdded: number | null;
  ratingChange: number | null;
  categoriesAdded: string[];
  categoriesRemoved: string[];
  postedSince: boolean;
};

const allCategories = (c: StoredProfile["categories"]) => [...(c.primary ? [c.primary] : []), ...c.additional];
const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);

/** Current profile against the one before (same data source; the caller guarantees that). */
export function diffProfiles(cur: StoredProfile, prev: StoredProfile): CompetitorProfileChange {
  const was = new Set(allCategories(prev.categories));
  const now = new Set(allCategories(cur.categories));
  const rating = delta(cur.rating, prev.rating);
  return {
    photosAdded: delta(cur.totalPhotos, prev.totalPhotos),
    reviewsAdded: delta(cur.reviewCount, prev.reviewCount),
    ratingChange: rating === null ? null : Math.round(rating * 10) / 10,
    categoriesAdded: [...now].filter((c) => !was.has(c)),
    categoriesRemoved: [...was].filter((c) => !now.has(c)),
    postedSince: !!cur.lastPostAt && (!prev.lastPostAt || cur.lastPostAt.getTime() > prev.lastPostAt.getTime()),
  };
}

// ---------------------------------------------------------------- transport

export type PostedTask = { placeId: string; ref: string | null; costUsd: number; error?: string };
export type ProfileTransport = {
  /** One task per place id. A place DataForSEO refused comes back with ref null and an error. */
  post(kind: ProfileKind, placeIds: readonly string[], locationCode: number): Promise<PostedTask[]>;
  /** The finished item(s), or "not_ready". `item` is items[0] for info; `result` is tasks[0].result[0]. */
  get(kind: ProfileKind, ref: string): Promise<{ state: "not_ready" } | { state: "ready"; result: unknown }>;
};

const OK = 20000;
const CREATED = 20100;

/** DataForSEO Business Data on OUR key. Never logs or throws the credentials. */
export function liveProfileTransport(opts: { fetch?: typeof fetch } = {}): ProfileTransport {
  const cfg = COMPETITOR_PROFILES;
  const doFetch = opts.fetch ?? globalThis.fetch;
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const creds = await platformDataForSeoCredentials();
    if (!creds) throw new Error("DataForSEO login and password are not set");
    const res = await doFetch(`${dataForSeoBaseUrl()}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${creds.login}:${creds.password}`).toString("base64")}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const json = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 402) throw new DfsAccountError(res.status, "");
    if (!res.ok) throw new DfsHttpError(res.status);
    const code = (json as { status_code?: number } | null)?.status_code;
    if (typeof code === "number" && (DFS_ERROR_CLASSES.account as readonly number[]).includes(code)) throw new DfsAccountError(code, "");
    if (typeof code === "number" && (DFS_ERROR_CLASSES.retryable as readonly number[]).includes(code)) throw new DfsRetryableError(code, "");
    return { status: res.status, json };
  }
  return {
    async post(kind, placeIds, locationCode) {
      const d = cfg.dataforseo;
      const body = placeIds.map((id) => ({
        keyword: `${d.keywordPrefix}${id}`,
        location_code: locationCode,
        language_code: d.languageCode,
        tag: id,
        ...(kind === "updates" ? { depth: d.updates.depth } : {}),
      }));
      const { json } = await call("POST", kind === "info" ? d.info.postPath : d.updates.postPath, body);
      const tasks = (json as { tasks?: { id?: string; status_code?: number; status_message?: string; cost?: number; data?: { tag?: string } }[] } | null)?.tasks ?? [];
      return placeIds.map((placeId, i) => {
        const t = tasks.find((x) => x.data?.tag === placeId) ?? tasks[i];
        if (t?.id && (t.status_code === CREATED || t.status_code === OK)) return { placeId, ref: t.id, costUsd: num(t.cost) ?? 0 };
        return { placeId, ref: null, costUsd: 0, error: `${t?.status_code ?? "no_task"} ${t?.status_message ?? ""}`.trim() };
      });
    },
    async get(kind, ref) {
      const d = cfg.dataforseo;
      const { json } = await call("GET", `${kind === "info" ? d.info.getPath : d.updates.getPath}${encodeURIComponent(ref)}`);
      const task = (json as { tasks?: { status_code?: number; status_message?: string; result?: unknown[] | null }[] } | null)?.tasks?.[0];
      if (!task) throw new Error("DataForSEO task_get: no task in response");
      if ((DFS_ERROR_CLASSES.notReady as readonly number[]).includes(task.status_code ?? 0)) return { state: "not_ready" };
      if (task.status_code !== OK) throw new Error(`DataForSEO task ${ref}: ${task.status_code} ${task.status_message}`);
      return { state: "ready", result: task.result?.[0] ?? null };
    },
  };
}

// ------------------------------------------------------------------ fixtures

function hash01(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0xffffffff;
}

const FIXTURE_CATEGORIES = [
  "Dentist",
  "Emergency dental service",
  "Cosmetic dentist",
  "Orthodontist",
  "Teeth whitening service",
  "Dental clinic",
  "Pediatric dentist",
];

/** Deterministic, no-network provider shaped like the DataForSEO answers. Refs carry the place id. Sample data only. */
export function fixtureProfileTransport(): ProfileTransport {
  return {
    async post(kind, placeIds) {
      return placeIds.map((placeId) => ({ placeId, ref: `fixture:${kind}:${placeId}`, costUsd: 0 }));
    },
    async get(kind, ref) {
      const placeId = ref.split(":").slice(2).join(":");
      if (kind === "info") {
        const first = Math.floor(hash01(placeId, "c") * FIXTURE_CATEGORIES.length);
        const extra = FIXTURE_CATEGORIES.filter((_, i) => i !== first && hash01(placeId, "x", i) > 0.6);
        return {
          state: "ready",
          result: {
            items: [
              {
                type: "google_business_info",
                place_id: placeId,
                category: FIXTURE_CATEGORIES[first],
                additional_categories: extra,
                category_ids: [FIXTURE_CATEGORIES[first]!, ...extra].map((c) => `gcid:${c.toLowerCase().replaceAll(" ", "_")}`),
                total_photos: 5 + Math.floor(hash01(placeId, "p") * 300),
                rating: { rating_type: "Max5", value: Math.round((3.4 + hash01(placeId, "r") * 1.6) * 10) / 10, votes_count: 5 + Math.floor(hash01(placeId, "v") * 400), rating_max: 5 },
              },
            ],
          },
        };
      }
      const n = Math.floor(hash01(placeId, "n") * 11);
      return {
        state: "ready",
        result: {
          items_count: n,
          items: Array.from({ length: n }, (_, i) => ({
            type: "google_business_post",
            timestamp: `${new Date(Date.UTC(2026, 9, 1) - i * 5 * 86_400_000).toISOString().slice(0, 10)} 00:00:00 +00:00`,
          })),
        },
      };
    },
  };
}
