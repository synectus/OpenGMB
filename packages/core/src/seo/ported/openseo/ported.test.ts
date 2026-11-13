import { describe, expect, it } from "vitest";
import { interleaveRows } from "./interleave";
import { normalizeIntent } from "./intent";
import { isAdsKeyword } from "./ads-keyword";
import { mapLabsItems } from "./labs-items";

describe("ported OpenSEO helpers", () => {
  it("interleaves, dedupes by keyword and stops at the limit", () => {
    const a = [{ keyword: "plumber" }, { keyword: "plumber near me" }, { keyword: "emergency plumber" }];
    const b = [{ keyword: "plumber near me" }, { keyword: "drain cleaning" }];
    expect(interleaveRows(a, b, 4).map((r) => r.keyword)).toEqual(["plumber", "plumber near me", "drain cleaning", "emergency plumber"]);
  });
  it("normalizes intent", () => {
    expect(normalizeIntent("Commercial")).toBe("commercial");
    expect(normalizeIntent("transactional")).toBe("transactional");
    expect(normalizeIntent(null)).toBe("unknown");
  });
  it("rejects keywords Google Ads would fail the whole task on", () => {
    expect(isAdsKeyword("plumber austin")).toBe(true);
    expect(isAdsKeyword("plumber, austin")).toBe(false);
    expect(isAdsKeyword("a ".repeat(11).trim())).toBe(false);
    expect(isAdsKeyword("x".repeat(81))).toBe(false);
    expect(isAdsKeyword("plumber 🔧")).toBe(false);
  });
  it("maps Labs items, lowercases and dedupes", () => {
    const rows = mapLabsItems([
      { keyword: "Plumber", keyword_info: { search_volume: 1000, cpc: 12.5, competition: 0.4, monthly_searches: [{ year: 2026, month: 10, search_volume: 900 }] }, keyword_properties: { keyword_difficulty: 37 }, search_intent_info: { main_intent: "commercial" } },
      { keyword: "plumber" },
      { keyword: null },
    ]);
    expect(rows).toEqual([
      { keyword: "plumber", searchVolume: 1000, trend: [{ year: 2026, month: 10, searchVolume: 900 }], cpc: 12.5, competition: 0.4, keywordDifficulty: 37, intent: "commercial" },
    ]);
  });
});
