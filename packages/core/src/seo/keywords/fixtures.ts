import type { LabsItem } from "../ported/openseo/labs-items";

/** Offline data in the documented DataForSEO response shapes (no key set, and every test). All costs are 0. */
export type AdsItem = {
  keyword: string;
  search_volume: number | null;
  cpc: number | null;
  competition: string | null;
  monthly_searches: { year: number; month: number; search_volume: number }[] | null;
};

const SUGGESTION_SUFFIXES = ["near me", "cost", "emergency", "reviews", "services", "24 hour", "prices", "licensed", "cheap", "best", "company", "repair", "for hire", "open now", "free estimate", "residential", "commercial", "kit", "tools", "job"];
const IDEA_WORDS = ["drain cleaning", "water heater repair", "leak detection", "pipe repair", "sewer line", "clogged toilet", "faucet installation", "garbage disposal", "burst pipe", "tankless water heater", "bathroom remodel", "gas line", "backflow testing", "hydro jetting", "sump pump", "toilet repair", "water softener", "repiping", "slab leak", "plumbing inspection"];

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function months(seed: number): { year: number; month: number; search_volume: number }[] {
  return Array.from({ length: 12 }, (_, i) => ({ year: 2026, month: (i % 12) + 1, search_volume: Math.round(seed * (0.8 + ((i * 7) % 5) / 10)) }));
}

export function fixtureLabsItem(keyword: string): LabsItem {
  const h = hash(keyword);
  const volume = 50 + (h % 9000);
  return {
    keyword,
    keyword_info: { search_volume: volume, cpc: Math.round((1 + (h % 2000) / 100) * 100) / 100, competition: (h % 100) / 100, monthly_searches: months(volume) },
    keyword_properties: { keyword_difficulty: h % 100 },
    search_intent_info: { main_intent: (["informational", "commercial", "transactional", "navigational"] as const)[h % 4] },
  };
}

/** Suggestions share the seed as a prefix; ideas are related topics. */
export function fixtureLabsItems(kind: "suggestions" | "ideas", seed: string, limit: number): { seed: LabsItem | null; items: LabsItem[] } {
  const s = seed.trim().toLowerCase();
  const words = kind === "suggestions" ? SUGGESTION_SUFFIXES.map((w) => `${s} ${w}`) : IDEA_WORDS.map((w) => (w.includes(s) ? w : `${w} ${s === "plumber" ? "" : s}`.trim()));
  return { seed: kind === "suggestions" ? fixtureLabsItem(s) : null, items: words.slice(0, limit).map(fixtureLabsItem) };
}

export function fixtureAdsItem(keyword: string, locationName: string): AdsItem {
  const h = hash(`${locationName}|${keyword}`);
  const volume = 10 + (h % 900);
  return { keyword, search_volume: volume, cpc: Math.round((1 + (h % 1500) / 100) * 100) / 100, competition: (["LOW", "MEDIUM", "HIGH"] as const)[h % 3]!, monthly_searches: months(volume) };
}

export type GeoRow = { location_code: number; location_name: string; location_type: string };

const GEO: Record<string, GeoRow[]> = {
  US: [
    { location_code: 1026201, location_name: "Austin,Texas,United States", location_type: "City" },
    { location_code: 1026339, location_name: "Dallas,Texas,United States", location_type: "City" },
    { location_code: 1023191, location_name: "New York,New York,United States", location_type: "City" },
    { location_code: 21176, location_name: "Texas,United States", location_type: "State" },
    { location_code: 21177, location_name: "Travis County,Texas,United States", location_type: "County" },
    { location_code: 200635, location_name: "Austin TX,Texas,United States", location_type: "DMA Region" },
  ],
  IN: [{ location_code: 1007788, location_name: "Mumbai,Maharashtra,India", location_type: "City" }],
  AU: [{ location_code: 1000286, location_name: "Sydney,New South Wales,Australia", location_type: "City" }],
  GB: [{ location_code: 1006886, location_name: "London,England,United Kingdom", location_type: "City" }],
  CA: [{ location_code: 1002451, location_name: "Toronto,Ontario,Canada", location_type: "City" }],
  NZ: [{ location_code: 1011089, location_name: "Auckland,Auckland,New Zealand", location_type: "City" }],
  AE: [{ location_code: 1007268, location_name: "Dubai,Dubai,United Arab Emirates", location_type: "City" }],
};

export function fixtureGeoRows(countryIso: string): GeoRow[] {
  return GEO[countryIso.toUpperCase()] ?? [];
}
