import { PLACE_ID } from "../review-links/pure";

export type PlaceChoice = { placeId: string; name: string; address: string };

/** A search the visitor typed. `search` returns Google's raw Autocomplete JSON (or the fixture's). */
export type PlaceSearch = (input: string) => Promise<unknown>;
export type PlaceCheck = (placeId: string) => Promise<boolean | null>;

/** Google place types that mean an area or an address, not a business. */
const NOT_A_BUSINESS = new Set([
  "locality", "political", "country", "postal_code", "route", "street_address", "street_number",
  "premise", "subpremise", "neighborhood", "sublocality", "colloquial_area", "geocode",
]);
const isArea = (t: string) => NOT_A_BUSINESS.has(t) || t.startsWith("administrative_area_level_") || t.startsWith("sublocality_");

export const MAX_CHOICES = 5;

/** Predictions with a valid Place ID that are not just an area. Junk in, empty list out. */
export function choicesFrom(raw: unknown): PlaceChoice[] {
  const list = (raw as { suggestions?: unknown })?.suggestions;
  if (!Array.isArray(list)) return [];
  const out: PlaceChoice[] = [];
  for (const s of list) {
    const p = (s as { placePrediction?: Record<string, unknown> })?.placePrediction;
    if (!p || typeof p.placeId !== "string" || !PLACE_ID.test(p.placeId)) continue;
    const types = Array.isArray(p.types) ? p.types.filter((t): t is string => typeof t === "string") : [];
    if (types.length > 0 && types.every(isArea)) continue;
    const f = p.structuredFormat as { mainText?: { text?: unknown }; secondaryText?: { text?: unknown } } | undefined;
    const name = typeof f?.mainText?.text === "string" ? f.mainText.text : "";
    if (!name) continue;
    out.push({ placeId: p.placeId, name, address: typeof f?.secondaryText?.text === "string" ? f.secondaryText.text : "" });
    if (out.length === MAX_CHOICES) break;
  }
  return out;
}

/** Takes one unit of the global budget first; a refusal never reaches Google. */
export async function searchPlaces(o: {
  query: string;
  search: PlaceSearch;
  takeBudget: () => Promise<boolean>;
}): Promise<{ status: "ok"; choices: PlaceChoice[] } | { status: "budget_exhausted" }> {
  if (!(await o.takeBudget())) return { status: "budget_exhausted" };
  return { status: "ok", choices: choicesFrom(await o.search(o.query)) };
}

/** Invented businesses for tests and local runs: three for any query containing "plumb", none otherwise. */
export const FIXTURE_PLACES: readonly PlaceChoice[] = [
  { placeId: "ChIJfixtureplumbing0001", name: "Example Plumbing Co", address: "100 Sample St, Springfield, IL, USA" },
  { placeId: "ChIJfixtureplumbing0002", name: "Sample Rooter and Plumbing", address: "200 Demo Ave, Springfield, IL, USA" },
  { placeId: "ChIJfixtureplumbing0003", name: "Demo Drain Plumbers", address: "300 Test Rd, Shelbyville, IL, USA" },
];

export const fixtureSearch: PlaceSearch = async (input) => ({
  suggestions: /plumb/i.test(input)
    ? FIXTURE_PLACES.map((c) => ({
        placePrediction: {
          placeId: c.placeId,
          types: ["plumber", "point_of_interest", "establishment"],
          structuredFormat: { mainText: { text: c.name }, secondaryText: { text: c.address } },
        },
      }))
    : [],
});

/** Fixture existence check: IDs starting `ChIJfixture` exist, others do not. */
export const fixtureCheck: PlaceCheck = async (id) => id.startsWith("ChIJfixture");
