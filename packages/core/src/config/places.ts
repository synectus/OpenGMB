/** Google Places API (New) endpoints and prices. Each entry carries its source and the date it was checked. */
export const PLACES_ENDPOINTS = {
  host: "https://places.googleapis.com",
  searchText: "/v1/places:searchText",
  autocomplete: "/v1/places:autocomplete",
  fieldMaskIdsOnly: "places.id",
  autocompleteFieldMask:
    "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat",
  sourceUrl: "https://developers.google.com/maps/documentation/places/web-service/text-search",
  verifiedOn: "2026-10-24",
} as const;

const PRICING_URL = "https://developers.google.com/maps/billing-and-pricing/pricing";

/** USD per 1,000 billable events; free cap per month per billing account. null freeCap = unlimited. */
export const PLACES_PRICING = {
  textSearchIdsOnly: { freePerMonth: null, perThousandUsd: 0, sourceUrl: PRICING_URL, verifiedOn: "2026-10-24" },
  autocompleteRequests: { freePerMonth: 10_000, perThousandUsd: 2.83, sourceUrl: PRICING_URL, verifiedOn: "2026-10-24" },
  placeDetailsIdsOnly: { freePerMonth: null, perThousandUsd: 0, sourceUrl: PRICING_URL, verifiedOn: "2026-10-24" },
  placeDetailsEssentials: { freePerMonth: 10_000, perThousandUsd: 5, sourceUrl: PRICING_URL, verifiedOn: "2026-10-24" },
  dynamicMaps: { freePerMonth: 10_000, perThousandUsd: 7, sourceUrl: PRICING_URL, verifiedOn: "2026-10-24" },
} as const;
