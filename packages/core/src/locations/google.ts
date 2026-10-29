import { GOOGLE_LIMITS } from "../config/google-limits";
import type { GoogleLocation, ListLocationsResponse } from "../google/client";

/** The fields import needs; Google requires a readMask on list. */
export const IMPORT_READ_MASK = "name,title,phoneNumbers,storefrontAddress,metadata";
/** Our own bound (not a Google number): stop following nextPageToken after this many pages. */
export const MAX_LOCATION_PAGES = 20;

type Lister = {
  listLocations(
    accountName: string,
    opts?: { readMask?: string; pageToken?: string; pageSize?: number },
  ): Promise<ListLocationsResponse>;
};

/** Follows nextPageToken up to `maxPages`; `truncated` says there was more we did not fetch. */
export async function fetchAllLocations(
  client: Lister,
  accountName: string,
  opts: { maxPages?: number; pageSize?: number } = {},
): Promise<{ locations: GoogleLocation[]; truncated: boolean }> {
  const maxPages = opts.maxPages ?? MAX_LOCATION_PAGES;
  const pageSize = opts.pageSize ?? GOOGLE_LIMITS.locationsListPageSize.limit;
  const locations: GoogleLocation[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await client.listLocations(accountName, {
      readMask: IMPORT_READ_MASK,
      pageSize,
      ...(pageToken ? { pageToken } : {}),
    });
    locations.push(...res.locations);
    if (!res.nextPageToken) return { locations, truncated: false };
    pageToken = res.nextPageToken;
  }
  return { locations, truncated: true };
}

export function addressSummary(l: GoogleLocation): string | null {
  const a = l.storefrontAddress;
  if (!a) return null;
  const parts = [
    ...(a.addressLines ?? []),
    a.locality,
    [a.administrativeArea, a.postalCode].filter(Boolean).join(" "),
    a.regionCode,
  ].filter((x): x is string => !!x);
  return parts.join(", ") || null;
}

/**
 * Whether Google reports the listing as verified and in good standing (metadata.hasVoiceOfMerchant).
 * Proto3 JSON omits false booleans: metadata present without the field is false; no metadata at all is unknown (null).
 */
export function hasVoiceOfMerchant(l: GoogleLocation): boolean | null {
  if (!l.metadata) return null;
  return l.metadata.hasVoiceOfMerchant === true;
}
