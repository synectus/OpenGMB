import { PROFILE_LIMITS } from "../config/profile-limits";
import type { GoogleAttribute, GoogleLocation } from "../google/client";
import { metadataLocale } from "./metadata";
import { snapshotFromGoogle, type ProfileSnapshot } from "./fields";
import type { ProfileWriter } from "./publish";

/**
 * profile.get only: the snapshot mask plus read-only facts the page shows. Never used by the watch,
 * the apply job or the healthcheck, so a wider read cannot create phantom suggestions or conflicts.
 */
export const PROFILE_GET_READ_MASK = `${PROFILE_LIMITS.readMask},languageCode`;

/** Read-only: the editable profile of `locations/{l}` as Google has it now, normalised. */
export async function fetchProfile(
  client: Pick<ProfileWriter, "getLocation" | "getAttributes">,
  googleLocationId: string,
  readMask: string = PROFILE_LIMITS.readMask,
): Promise<{ snapshot: ProfileSnapshot; attributes: GoogleAttribute[]; location: GoogleLocation }> {
  const loc = await client.getLocation(googleLocationId, { readMask });
  const attrs = await client.getAttributes(`${googleLocationId}/attributes`);
  return {
    snapshot: snapshotFromGoogle(loc, attrs),
    attributes: attrs.attributes ?? [],
    location: loc,
  };
}

/**
 * What the profile page shows but never edits: Google's category display names (the snapshot keeps
 * ids only so diffs stay stable) and the locale.
 */
export function profileDisplay(loc: GoogleLocation): {
  categoryNames: Record<string, string>;
  regionCode: string;
  languageCode: string;
} {
  const categoryNames: Record<string, string> = {};
  for (const c of [
    loc.categories?.primaryCategory,
    ...(loc.categories?.additionalCategories ?? []),
  ]) {
    if (c?.name && c.displayName) categoryNames[c.name] = c.displayName;
  }
  return {
    categoryNames,
    ...metadataLocale(loc),
  };
}
