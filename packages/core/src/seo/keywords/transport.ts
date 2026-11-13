import { DFS_ERROR_CLASSES } from "../../config/geogrid";
import { SEO_ENDPOINTS, SEO_KEYWORDS, SEO_PRICES } from "../../config/seo";
import { DfsAccountError, DfsHttpError, DfsRetryableError } from "../../geogrid/drivers/errors";
import { dataForSeoBaseUrl, platformDataForSeoCredentials } from "../../geogrid/drivers/source";
import type { DfsCredentials } from "../../geogrid/drivers/fixtures";
import type { LabsItem } from "../ported/openseo/labs-items";
import { fixtureAdsItem, fixtureGeoRows, fixtureLabsItems, type AdsItem, type GeoRow } from "./fixtures";

export type { AdsItem, GeoRow };
export type LabsKind = "suggestions" | "ideas";
/** A task DataForSEO answered with an error code we do not classify (not an account or retryable one). */
export class DfsTaskError extends Error {
  constructor(readonly code: number, message: string) {
    super(`DataForSEO task ${code} ${message}`.trim());
    this.name = "DfsTaskError";
  }
}

export type KeywordTransport = {
  /** True for the offline transport: its data is sample data and must never be stored as the real thing. */
  fixture?: boolean;
  labs(kind: LabsKind, q: { seed: string; locationCode: number; languageCode: string; limit: number }): Promise<{ items: LabsItem[]; costUsd: number }>;
  adsVolume(q: { keywords: string[]; locationName: string; languageCode: string }): Promise<{ items: AdsItem[]; costUsd: number }>;
  adsLocations(countryIso: string): Promise<GeoRow[]>;
};

const OK = 20000;

type Envelope = {
  status_code?: number;
  status_message?: string;
  tasks?: { status_code?: number; status_message?: string; cost?: number; result?: unknown[] | null }[];
};

/** Live transport on our DataForSEO key. Credentials never reach a message or a log. */
export function liveKeywordTransport(opts: { fetch?: typeof fetch; credentials?: () => Promise<DfsCredentials | null> } = {}): KeywordTransport {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const credentials = opts.credentials ?? platformDataForSeoCredentials;

  async function call(path: string, body: unknown | null): Promise<{ task: NonNullable<Envelope["tasks"]>[number]; cost: number | null }> {
    const creds = await credentials();
    if (!creds) throw new Error("DataForSEO login and password are not set");
    const res = await doFetch(`${dataForSeoBaseUrl()}${path}`, {
      method: body === null ? "GET" : "POST",
      headers: { authorization: `Basic ${Buffer.from(`${creds.login}:${creds.password}`).toString("base64")}`, "content-type": "application/json" },
      ...(body === null ? {} : { body: JSON.stringify([body]) }),
      signal: AbortSignal.timeout(SEO_KEYWORDS.timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as Envelope | null;
    if (res.status === 401 || res.status === 402) throw new DfsAccountError(res.status, json?.status_message ?? "");
    if (!res.ok) throw new DfsHttpError(res.status);
    const code = json?.status_code;
    if (typeof code === "number" && (DFS_ERROR_CLASSES.account as readonly number[]).includes(code)) throw new DfsAccountError(code, json?.status_message ?? "");
    if (typeof code === "number" && (DFS_ERROR_CLASSES.retryable as readonly number[]).includes(code)) throw new DfsRetryableError(code, json?.status_message ?? "");
    const task = json?.tasks?.[0];
    const tcode = task?.status_code;
    if (typeof tcode === "number" && (DFS_ERROR_CLASSES.account as readonly number[]).includes(tcode)) throw new DfsAccountError(tcode, task?.status_message ?? "");
    if (typeof tcode === "number" && (DFS_ERROR_CLASSES.retryable as readonly number[]).includes(tcode)) throw new DfsRetryableError(tcode, task?.status_message ?? "");
    // Anything but a clean 20000 is a failure, never an empty success.
    if (!task || tcode !== OK) throw new DfsTaskError(typeof tcode === "number" ? tcode : 0, task?.status_message ?? "no task in the answer");
    return { task, cost: typeof task.cost === "number" ? task.cost : null };
  }

  return {
    async labs(kind, q) {
      const common = { location_code: q.locationCode, language_code: q.languageCode, limit: q.limit, include_serp_info: false, include_clickstream_data: false };
      const { task, cost } =
        kind === "suggestions"
          ? await call(SEO_ENDPOINTS.labsSuggestions, { keyword: q.seed, ...common, include_seed_keyword: true })
          : await call(SEO_ENDPOINTS.labsIdeas, { keywords: [q.seed], ...common });
      const first = task?.result?.[0] as { items?: LabsItem[] | null; seed_keyword_data?: LabsItem | null } | undefined;
      const items = [...(kind === "suggestions" && first?.seed_keyword_data ? [first.seed_keyword_data] : []), ...(first?.items ?? [])];
      // No reported cost: count the configured price so platform-cap accounting is never skipped.
      return { items, costUsd: cost ?? SEO_PRICES.labs.perTaskUsd + items.length * SEO_PRICES.labs.perRowUsd };
    },
    async adsVolume(q) {
      const { task, cost } = await call(SEO_ENDPOINTS.adsSearchVolume, { keywords: q.keywords, location_name: q.locationName, language_code: q.languageCode });
      return { items: (task.result ?? []) as AdsItem[], costUsd: cost ?? SEO_PRICES.googleAdsLive.perTaskUsd };
    },
    async adsLocations(countryIso) {
      const { task } = await call(`${SEO_ENDPOINTS.adsLocations}${countryIso.toLowerCase()}`, null);
      return (task.result ?? []) as GeoRow[];
    },
  };
}

/** Offline transport (no key set, and every test): documented shapes, every cost 0. */
export function fixtureKeywordTransport(): KeywordTransport {
  return {
    fixture: true,
    async labs(kind, q) {
      const { seed, items } = fixtureLabsItems(kind, q.seed, q.limit);
      return { items: [...(seed ? [seed] : []), ...items], costUsd: 0 };
    },
    async adsVolume(q) {
      return { items: q.keywords.map((k) => fixtureAdsItem(k, q.locationName)), costUsd: 0 };
    },
    async adsLocations(countryIso) {
      return fixtureGeoRows(countryIso);
    },
  };
}
