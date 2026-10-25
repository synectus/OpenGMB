import { PLACES_ENDPOINTS } from "../config/places";
import type { PlacesSearchRequest, PlacesSearchResponse, PlacesTransport } from "../geogrid/drivers/fixtures";
import { getIntegrationFresh, integrationEnv } from "../integrations";

/** A non-2xx Places answer. Carries Google's `error.status` (such as PERMISSION_DENIED), never the key. */
export class PlacesHttpError extends Error {
  constructor(
    readonly status: number,
    readonly googleStatus: string | null,
  ) {
    super(`Google Places answered HTTP ${status}${googleStatus ? ` ${googleStatus}` : ""}`);
    this.name = "PlacesHttpError";
  }
}

export type LivePlacesOptions = {
  baseUrl?: string;
  /** Resolved on every call, so a key entered or cleared while the server runs applies at once. */
  key: () => Promise<string | null | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** Places API (New) Text Search with the IDs-only field mask (free SKU). */
export function livePlacesTransport(opts: LivePlacesOptions): PlacesTransport {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? PLACES_ENDPOINTS.host;
  return {
    async searchText(req: PlacesSearchRequest): Promise<PlacesSearchResponse> {
      const key = await opts.key();
      if (!key) throw new Error("GOOGLE_PLACES_SERVER_KEY is not set");
      // `targetPlaceId` is fixture-only: the real API cannot know which place we are ranking.
      const body = {
        textQuery: req.textQuery,
        pageSize: req.maxResultCount,
        locationBias: req.locationBias,
      };
      const res = await doFetch(`${baseUrl}${PLACES_ENDPOINTS.searchText}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": key,
          "x-goog-fieldmask": PLACES_ENDPOINTS.fieldMaskIdsOnly,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      const json = (await res.json().catch(() => null)) as {
        places?: { id?: string }[];
        error?: { status?: string };
      } | null;
      if (!res.ok) throw new PlacesHttpError(res.status, json?.error?.status ?? null);
      return { places: (json?.places ?? []).flatMap((p) => (p.id ? [{ id: p.id }] : [])) };
    },
  };
}

/** Live when the server has a Places key (environment or entered in the app), else fixtures. */
export function placesSource(env: Record<string, string | undefined> = integrationEnv()): "live" | "fixture" {
  return env.GOOGLE_PLACES_SERVER_KEY?.trim() ? "live" : "fixture";
}

export const placesServerKey = () => getIntegrationFresh("GOOGLE_PLACES_SERVER_KEY");

export type LiveAutocompleteOptions = LivePlacesOptions & { fieldMask: string };

/** Places API (New) Autocomplete: one POST per search, no session token (billed per request). Returns Google's raw JSON. */
export function liveAutocomplete(opts: LiveAutocompleteOptions): (input: string) => Promise<unknown> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? PLACES_ENDPOINTS.host;
  return async (input) => {
    const key = await opts.key();
    if (!key) throw new Error("GOOGLE_PLACES_SERVER_KEY is not set");
    const res = await doFetch(`${baseUrl}${PLACES_ENDPOINTS.autocomplete}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key, "x-goog-fieldmask": opts.fieldMask },
      body: JSON.stringify({ input, languageCode: "en" }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    const json = (await res.json().catch(() => null)) as { error?: { status?: string } } | null;
    if (!res.ok) throw new PlacesHttpError(res.status, json?.error?.status ?? null);
    return json;
  };
}

/** Place Details with the `id` field mask (Essentials IDs Only, free). true = exists, false = 404, null = could not check. */
export function livePlaceExists(opts: LivePlacesOptions): (placeId: string) => Promise<boolean | null> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? PLACES_ENDPOINTS.host;
  return async (placeId) => {
    try {
      const key = await opts.key();
      if (!key) return null;
      const res = await doFetch(`${baseUrl}/v1/places/${encodeURIComponent(placeId)}`, {
        method: "GET",
        headers: { "x-goog-api-key": key, "x-goog-fieldmask": "id" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
      });
      if (res.ok) return true;
      return res.status === 404 ? false : null;
    } catch {
      return null;
    }
  };
}
