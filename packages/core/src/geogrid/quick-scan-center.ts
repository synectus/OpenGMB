import { CoreError } from "../errors";
import { livePlacesCenter } from "../locations/center";
import { placesSource } from "../places/client";

export type Locate = (placeId: string) => Promise<{ lat: number; lng: number } | null>;

/** The quick scan's centre: the caller's coordinates, or the place's own location from Places. */
export async function resolveScanCenter(
  placeId: string,
  input: { centerLat?: number; centerLng?: number },
  locate: Locate,
): Promise<{ lat: number; lng: number }> {
  const hasLat = input.centerLat !== undefined;
  const hasLng = input.centerLng !== undefined;
  if (hasLat !== hasLng) throw new CoreError("INVALID_INPUT", "Send both centerLat and centerLng, or neither");
  if (hasLat) return { lat: input.centerLat!, lng: input.centerLng! };
  const at = await locate(placeId).catch(() => null);
  if (!at) throw new CoreError("INVALID_INPUT", "Could not find that place on Google Maps; send centerLat and centerLng");
  return at;
}

const FIXTURE_CENTER = { lat: 39.78, lng: -89.65 };

/** The Places lookup the quick scan uses (5 s: it runs inside the action transaction): live Place Details when the server has a Places key, else fixtures (ids starting ChIJfixture). */
export const scanLocate: Locate = (placeId) =>
  placesSource() === "live"
    ? livePlacesCenter({ timeoutMs: 5_000 })({ placeId, query: "" })
    : Promise.resolve(placeId.startsWith("ChIJfixture") ? FIXTURE_CENTER : null);
