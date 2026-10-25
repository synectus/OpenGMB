import { CoreError } from "../../errors";
import { createDataForSeoDriver } from "./dataforseo";
import {
  fixtureByoTransport,
  type DataForSeoTransport,
  type DfsCredentialCheck,
  type DfsCredentials,
  type PlacesTransport,
} from "./fixtures";
import { createPlacesRelevanceDriver } from "./places";
import { liveDataForSeoTransport } from "./live-dataforseo";
import type { RankSource } from "./source";
import type { GridDriver, GridTarget, RankedResult } from "./types";
import type { Competitor, PointResult } from "../analytics";
import { DATAFORSEO_ENDPOINTS, type GridSpeed } from "../../config/geogrid";

export * from "./types";
export { createDataForSeoDriver, parseDataForSeoTaskGet, parseSerpTaskGet } from "./dataforseo";
export { createPlacesRelevanceDriver } from "./places";
export * from "./fixtures";

export type DriverDeps = {
  dataForSeo?: DataForSeoTransport;
  places?: PlacesTransport;
  /** Transport authenticated with an org's own DataForSEO credentials (B1). Defaults to the fixture. */
  byoDataForSeo?: (creds: DfsCredentials) => DataForSeoTransport;
  /** Where rank data comes from right now. Default: fixtures, so tests stay offline unless they opt in. */
  source?: () => RankSource;
  /** Where the relevance check gets its data right now. Default: fixtures. */
  placesSource?: () => "live" | "fixture";
  /** Builds the live platform transport for a DataForSEO host (called once per host; reads credentials per call). */
  liveDataForSeo?: (baseUrl: string) => DataForSeoTransport;
  livePlaces?: () => PlacesTransport;
  /** Builds a live transport for an org's own credentials. Defaults to the live DataForSEO transport. */
  liveByoDataForSeo?: (creds: DfsCredentials, baseUrl: string) => DataForSeoTransport;
};

export type DriverOptions = {
  credentials?: DfsCredentials;
  /** The data source a run was requested with. Overrides the current source, so a pre-K1 run or a run
   * requested before a key was entered is always collected from where it was submitted. */
  dataSource?: RankSource;
  /** Queue speed of the run (DataForSEO sources only). Default standard. */
  speed?: GridSpeed;
};

const hostFor = (ds: RankSource) =>
  ds === "sandbox" ? DATAFORSEO_ENDPOINTS.hosts[1] : DATAFORSEO_ENDPOINTS.hosts[0];

/**
 * Driver lookup. Live or fixture is decided on every lookup (never at import time), because an
 * admin can enter or clear a key while the app runs. Drivers are created once per source and
 * reused (the relevance driver holds its in-flight answers).
 */
export function createDriverRegistry(deps: DriverDeps = {}) {
  const source = deps.source ?? (() => "fixture" as RankSource);
  const placesNow = deps.placesSource ?? (() => "fixture" as const);
  const byoFixture = deps.byoDataForSeo ?? fixtureByoTransport;
  const fixtureRank: Record<GridSpeed, GridDriver> = {
    standard: createDataForSeoDriver(deps.dataForSeo, "standard"),
    fast: createDataForSeoDriver(deps.dataForSeo, "fast"),
  };
  const fixtureSerp: Record<GridSpeed, GridDriver> = {
    standard: createDataForSeoDriver(deps.dataForSeo, "standard", "organic"),
    fast: createDataForSeoDriver(deps.dataForSeo, "fast", "organic"),
  };
  const liveRank = new Map<string, GridDriver>();
  const fixturePlaces = createPlacesRelevanceDriver(deps.places);
  let livePlacesDriver: GridDriver | null = null;

  const byoTransport = (creds: DfsCredentials, ds: RankSource): DataForSeoTransport => {
    if (ds === "fixture") return byoFixture(creds);
    const baseUrl = hostFor(ds);
    return (
      deps.liveByoDataForSeo?.(creds, baseUrl) ??
      liveDataForSeoTransport({ baseUrl, credentials: async () => creds })
    );
  };

  const lookup = (id: string, opts: DriverOptions = {}): GridDriver => {
    if (id === "dataforseo_standard" || id === "dataforseo_serp") {
      const product = id === "dataforseo_serp" ? "organic" : "maps";
      const ds = opts.dataSource ?? source();
      const speed = opts.speed ?? "standard";
      // A BYO run talks to DataForSEO as the customer.
      if (opts.credentials) return createDataForSeoDriver(byoTransport(opts.credentials, ds), speed, product);
      if (ds === "fixture") return (product === "organic" ? fixtureSerp : fixtureRank)[speed];
      const key = `${product}:${ds}:${speed}`;
      let d = liveRank.get(key);
      if (!d) {
        const baseUrl = hostFor(ds);
        const transport = deps.liveDataForSeo?.(baseUrl);
        if (!transport) throw new Error("No live DataForSEO transport is configured");
        d = createDataForSeoDriver(transport, speed, product);
        liveRank.set(key, d);
      }
      return d;
    }
    if (id === "places_relevance") {
      const ds = opts.dataSource ?? placesNow();
      if (ds === "fixture") return fixturePlaces;
      if (!livePlacesDriver) {
        if (!deps.livePlaces) throw new Error("No live Places transport is configured");
        livePlacesDriver = createPlacesRelevanceDriver(deps.livePlaces());
      }
      return livePlacesDriver;
    }
    throw new CoreError("INVALID_INPUT", `Unknown geo-grid driver ${id}`);
  };
  return Object.assign(lookup, {
    /** Where a run requested now for this driver would get its data. */
    dataSource: (driverId: string): RankSource =>
      driverId === "places_relevance" ? placesNow() : source(),
    /** The credential check of the DataForSEO transport for these credentials. */
    checkDataForSeoCredentials: async (creds: DfsCredentials): Promise<DfsCredentialCheck> =>
      (await byoTransport(creds, source()).checkCredentials?.()) ?? {
        ok: false,
        message: "This transport has no credential check",
      },
  });
}
export type DriverRegistry = ReturnType<typeof createDriverRegistry>;

const norm = (s: string | null) => (s ?? "").trim().toLowerCase();

/** A domain without scheme, path or "www.", lowercase; null when empty. */
export function normalizeDomain(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim().toLowerCase();
  if (!raw) return null;
  const host = raw.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0]!.replace(/^www\./, "");
  return host || null;
}

const domainMatches = (a: string | null | undefined, b: string | null | undefined) => {
  const x = normalizeDomain(a);
  const y = normalizeDomain(b);
  return x !== null && x === y;
};

/** Find the target in a point's results and build what we store: rank, top3, competitors. */
export function resolvePointResult(allResults: RankedResult[], target: GridTarget): PointResult {
  // Keyword rank (K4): the local pack is matched like Maps results (by domain, then title); organic results by domain.
  const organicHit = allResults.find((r) => r.kind === "organic" && domainMatches(r.domain, target.domain));
  const results = allResults.filter((r) => r.kind !== "organic");
  const isTarget = (r: RankedResult) =>
    r.kind === "local_pack"
      ? domainMatches(r.domain, target.domain) || norm(r.title) === norm(target.name)
      : target.placeId
        ? r.placeId === target.placeId
        : norm(r.title) === norm(target.name);
  const competitors: Competitor[] = results.map((r) => ({
    rank: r.rank,
    title: r.title,
    placeId: r.placeId,
    rating: r.rating,
    isTarget: isTarget(r),
    address: r.address ?? null,
    reviewCount: r.reviewCount ?? null,
    ...(r.category ? { category: r.category, additionalCategories: r.additionalCategories ?? [], categoryIds: r.categoryIds ?? [] } : {}),
  }));
  const hit = competitors.find((c) => c.isTarget);
  const rank = hit ? hit.rank : null;
  return {
    rank,
    top3: rank !== null && rank <= 3,
    competitors,
    ...(allResults.some((r) => r.kind)
      ? { organicRank: organicHit ? organicHit.rank : null, organicUrl: organicHit?.url ?? null }
      : {}),
  };
}
export * from "./source";
export { liveDataForSeoTransport } from "./live-dataforseo";
export * from "./errors";
export { createLiveDriverRegistry } from "./live";
