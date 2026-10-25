/**
 * Where a location's stored coordinates can come from, and what each lookup costs. Each external
 * fact carries its source URL and the date it was checked; logic reads these, never a literal.
 */
export const LOCATION_CENTER = {
  /** DataForSEO Business Data, Google My Business Info, Live. One profile per call, on OUR key. */
  dataforseo: {
    host: "https://api.dataforseo.com",
    path: "/v3/business_data/google/my_business_info/live",
    /** `keyword` takes "place_id:<id>" (or "cid:<id>"); the docs also require a location and a language. */
    keywordPrefix: "place_id:",
    /** `location_code` comes from the business's country: see DFS_COUNTRY_LOCATIONS. */
    languageCode: "en",
    /** Response: tasks[].result[].items[].latitude / .longitude (floats); tasks[].cost is the charge. */
    perProfileUsd: 0.0054,
    standardQueueUsd: 0.0015,
    sourceUrl: "https://docs.dataforseo.com/v3/business_data/google/my_business_info/live/",
    pricingUrl: "https://dataforseo.com/pricing/business-data/business-data-api",
    verifiedOn: "2026-10-24",
    note: "Live $0.0054 per profile, Standard queue $0.0015 (pricing page, 2026-10-24). Live is used: the lookup is one-off and a person is waiting for a map centre.",
  },
  /** Google Places API (New). Used only when GOOGLE_PLACES_SERVER_KEY is set (in-app or env). */
  places: {
    host: "https://places.googleapis.com",
    detailsPath: "/v1/places/",
    searchTextPath: "/v1/places:searchText",
    detailsFieldMask: "location",
    searchTextFieldMask: "places.location",
    detailsPricingKey: "placeDetailsEssentials",
    sourceUrl: "https://developers.google.com/maps/documentation/places/web-service/place-details",
    pricingUrl: "https://developers.google.com/maps/billing-and-pricing/pricing",
    verifiedOn: "2026-10-24",
    note: "Place Details with the location field is Essentials (see PLACES_PRICING.placeDetailsEssentials). Text Search with places.location is a higher SKU whose price was not re-verified; it is only a fallback when Google gave no place id.",
  },
  timeoutMs: 15_000,
} as const;
