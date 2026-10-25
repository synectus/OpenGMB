import type { GoogleReview, GoogleStarRatingEnum, RawGoogleReview } from "./client";

const STARS: Record<GoogleStarRatingEnum, number | null> = {
  STAR_RATING_UNSPECIFIED: null,
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

/** v4 StarRating enum -> 1..5, or null for STAR_RATING_UNSPECIFIED, missing or unknown values. */
export function mapStarRating(value: string | undefined | null): number | null {
  if (!value) return null;
  return (STARS as Record<string, number | null>)[value] ?? null;
}

export function mapReview(raw: RawGoogleReview): GoogleReview {
  const { starRating, ...rest } = raw;
  return { ...rest, starRating: mapStarRating(starRating) };
}

/** `accounts/{a}/locations/{l}/reviews/{r}` -> parts, or null when it is not a review name. */
export function parseReviewName(
  name: string,
): { accountName: string; locationName: string; reviewId: string } | null {
  const m = /^(accounts\/[^/]+)\/(locations\/[^/]+)\/reviews\/([^/]+)$/.exec(name);
  return m && !name.includes("..")
    ? { accountName: m[1]!, locationName: m[2]!, reviewId: m[3]! }
    : null;
}
