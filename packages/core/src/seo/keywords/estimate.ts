import { SEO_PRICES } from "../../config/seo";

/** DataForSEO cost upper bound (USD, before markup): two Labs tasks of ceil(rows/2) items plus the seed row each, plus one Ads task for a city. */
export function researchEstimateUsd(p: { rows: number; city: boolean }): number {
  const half = Math.ceil(p.rows / 2);
  const labs = 2 * SEO_PRICES.labs.perTaskUsd + 2 * (half + 1) * SEO_PRICES.labs.perRowUsd;
  return labs + (p.city ? SEO_PRICES.googleAdsLive.perTaskUsd : 0);
}

export const normalizeSeed = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function cacheKey(p: { workspaceId: string; seed: string; countryIso: string; city: string | null; rows: number }): string {
  return [p.workspaceId, normalizeSeed(p.seed), p.countryIso.toUpperCase(), p.city ?? "", p.rows].join("|");
}
