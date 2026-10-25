/**
 * DataForSEO `location_code` per country, for Business Data tasks (the coordinate lookup and the
 * competitor profile tasks). The code follows the country of the tracked business's storefront
 * address, never a fixed country. Codes read from DataForSEO's Google locations list (country rows,
 * country_iso_code -> location_code) and checked on 2026-10-24. The list is the SERP one; Business Data
 * uses the same location codes (its locations page links the same list).
 */
export const DFS_COUNTRY_LOCATIONS = {
  /** Used when the address has no region code, or one not listed here. */
  fallbackRegion: "US",
  codes: {
    IN: 2356,
    US: 2840,
    AU: 2036,
    GB: 2826,
    CA: 2124,
    NZ: 2554,
    AE: 2784,
  } as Readonly<Record<string, number>>,
  sourceUrl: "https://docs.dataforseo.com/v3/serp/google/locations/",
  csvUrl: "https://cdn.dataforseo.com/v3/locations/locations_serp_google_2026_09_01.csv",
  verifiedOn: "2026-10-24",
} as const;

/** The DataForSEO location_code for an ISO country code (case-insensitive); the US one when unknown. */
export function dfsLocationCodeFor(regionCode: string | null | undefined): number {
  const c = DFS_COUNTRY_LOCATIONS.codes;
  return (regionCode ? c[regionCode.trim().toUpperCase()] : undefined) ?? c[DFS_COUNTRY_LOCATIONS.fallbackRegion]!;
}
