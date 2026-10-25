import { PLACES_PRICING } from "./places";

/**
 * The Google review link. Google's help pages (answer/16816815) describe how to get the link in
 * Business Profile but do not print the pattern, and the Places docs do not list it. Production
 * /go/ links have used this format since R1. "verified" only after a person opens a generated link
 * while signed in to Google and sees the review box for that business (agents cannot sign in). A
 * signed-out request only proves the path exists: on 2026-10-24 a real and a fake Place ID both
 * answered 302 to Google sign-in, and a wrong path answered 404. It was confirmed signed in on
 * 2026-10-24 (placeid ChIJz8XwDgUrXDkRzu-160JqoY4 opened the review box).
 */
export const GOOGLE_REVIEW_LINK = {
  template: "https://search.google.com/local/writereview?placeid={placeId}",
  sourceUrl: "https://developers.google.com/maps/documentation/places/web-service/place-id",
  verifiedOn: "2026-10-24",
  status: "verified" as "verified" | "unverified",
  note: "A tester opened a generated link signed in to Google on 2026-10-24 and it showed the review box for that business. Neither Google help page names the pattern.",
} as const;

/** Google's review policy, paraphrased on the page. Lines read from the page on the date below. */
export const REVIEW_POLICY = {
  sourceUrl: "https://support.google.com/contributionpolicy/answer/7400114",
  verifiedOn: "2026-10-24",
  status: "verified" as const,
  note: "Merchants may not offer payment, discounts or free goods or services for a review, may not selectively solicit positive reviews, and may not discourage or prohibit negative reviews. Asking for reviews in general is allowed.",
} as const;

/** How Google wants Places results credited when no Google map is shown. */
export const PLACES_ATTRIBUTION = {
  text: "Google Maps",
  sourceUrl: "https://developers.google.com/maps/documentation/places/web-service/policies",
  verifiedOn: "2026-10-24",
  note: "Without a Google map, show the Google Maps logo, or the unaltered words \"Google Maps\" when space is tight, near the content inside the same container. Place IDs may be stored; other Places content may not be cached.",
} as const;

/** Where to find a Place ID by hand, and how to get the link inside Business Profile. */
export const REVIEW_LINK_HELP = {
  placeIdFinderUrl: "https://developers.google.com/maps/documentation/javascript/examples/places-placeid-finder",
  businessProfileHelpUrl: "https://support.google.com/business/answer/16816815",
  verifiedOn: "2026-10-24",
  note: "Business Profile steps: Read reviews, Get more reviews, share icon. Review QR codes can only be generated on a computer browser.",
} as const;

/** Our own choices. */
export const REVIEW_LINK_TOOL = {
  perIpPerMinute: 5,
  perIpPerDay: 10,
  /** A 31-day month at this cap stays inside the Autocomplete free allowance. */
  globalPerDay: Math.floor((PLACES_PRICING.autocompleteRequests.freePerMonth ?? 0) / 31),
  queryMinChars: 2,
  queryMaxChars: 120,
  /** Only what the picker shows plus `types`, so the server can drop non-business predictions. */
  autocompleteFieldMask:
    "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types",
  placeDetailsFieldMask: "id",
  timeoutMs: 5_000,
  budgetBucket: "review-link-search",
} as const;

/** Cost of a 31-day month with every day at the global cap. */
export function monthlyCostAtCapUsd(o: { freeTierAvailable: boolean }): number {
  const p = PLACES_PRICING.autocompleteRequests;
  const calls = REVIEW_LINK_TOOL.globalPerDay * 31;
  const billable = o.freeTierAvailable ? Math.max(0, calls - (p.freePerMonth ?? 0)) : calls;
  return (billable * p.perThousandUsd) / 1000;
}

export type ReviewLinkSearchMode = "live" | "fixture" | "off";

/**
 * Fixture only when asked for and never in production; live when a Places key exists (environment
 * or entered in the app, `hasKey`); otherwise off, so the page hides search. Unlike
 * `placesSource()`, "no key" is never fixtures here: visitors must not see invented businesses.
 */
export function reviewLinkSearchMode(env: Record<string, string | undefined>, hasKey: boolean): ReviewLinkSearchMode {
  if (env.PLACES_API_MODE === "fixture" && env.NODE_ENV !== "production") return "fixture";
  return hasKey ? "live" : "off";
}

/** Free facts the config test walks. */
export const REVIEW_LINK_FACTS = [
  GOOGLE_REVIEW_LINK,
  REVIEW_POLICY,
  PLACES_ATTRIBUTION,
  PLACES_PRICING.autocompleteRequests,
  PLACES_PRICING.placeDetailsIdsOnly,
] as const;
