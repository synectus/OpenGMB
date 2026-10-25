import type { GooglePlaceActionLink } from "../google/client";
import type { ThrottledGoogleClient } from "../google/throttled-client";
import { PLACE_ACTION_LIMITS } from "../config/media-limits";
import { assertHttpsUrl } from "../locationOps/access";
import { CoreError } from "../errors";
import { PLACE_ACTION_TYPES } from "../google/client";

/**
 * The ONLY place outside the Google client implementations that creates, patches or deletes place
 * action links (booking / ordering URLs). A test (`reply-enforcement.test.ts`) fails if any other
 * source file calls `.createPlaceActionLink(`, `.updatePlaceActionLink(` or `.deletePlaceActionLink(`.
 * Writes go through the throttled client (per-location edit bucket + idempotency key
 * `placeaction:<opId>`). Content check: https URI, no credentials, a type from the supported list.
 */
export type PlaceActionWriter = Pick<
  ThrottledGoogleClient,
  "createPlaceActionLink" | "updatePlaceActionLink" | "deletePlaceActionLink"
>;

export const placeActionKey = (opId: string) => `placeaction:${opId}`;

type Where = { orgId: string; opId: string };
const ctx = (w: Where) => ({ orgId: w.orgId, idempotencyKey: placeActionKey(w.opId) });
const checkUri = (uri: string) =>
  assertHttpsUrl(uri, { maxLength: PLACE_ACTION_LIMITS.uriMaxLength });
const checkType = (t: string) => {
  if (!(PLACE_ACTION_TYPES as readonly string[]).includes(t)) {
    throw new CoreError("INVALID_INPUT", `Unsupported place action type ${t}`);
  }
};

export function publishPlaceActionCreate(
  client: PlaceActionWriter,
  where: Where & { locationName: string },
  link: { uri: string; placeActionType: string; isPreferred?: boolean },
): Promise<GooglePlaceActionLink> {
  checkUri(link.uri);
  checkType(link.placeActionType);
  return client.createPlaceActionLink(
    where.locationName,
    {
      uri: link.uri,
      placeActionType: link.placeActionType,
      ...(link.isPreferred !== undefined ? { isPreferred: link.isPreferred } : {}),
    },
    ctx(where),
  );
}

/** `patch` holds only the fields to change; the mask is exactly its keys. */
export function publishPlaceActionUpdate(
  client: PlaceActionWriter,
  where: Where & { locationName: string },
  name: string,
  patch: { uri?: string; placeActionType?: string; isPreferred?: boolean },
): Promise<GooglePlaceActionLink> {
  if (!name.startsWith(`${where.locationName}/placeActionLinks/`)) {
    throw new CoreError("INVALID_INPUT", "Place action link belongs to another location");
  }
  if (patch.uri !== undefined) checkUri(patch.uri);
  if (patch.placeActionType !== undefined) checkType(patch.placeActionType);
  const mask = (["uri", "placeActionType", "isPreferred"] as const).filter(
    (k) => patch[k] !== undefined,
  );
  if (mask.length === 0) throw new CoreError("INVALID_INPUT", "Nothing to update");
  return client.updatePlaceActionLink(name, patch, mask, ctx(where));
}

export function publishPlaceActionDelete(
  client: PlaceActionWriter,
  where: Where & { locationName: string },
  name: string,
): Promise<void> {
  if (!name.startsWith(`${where.locationName}/placeActionLinks/`)) {
    throw new CoreError("INVALID_INPUT", "Place action link belongs to another location");
  }
  return client.deletePlaceActionLink(name, ctx(where));
}
