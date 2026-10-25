import { describe, expect, it } from "vitest";
import { CITATION_COUNTRIES, CITATION_SITES, CITATION_SITES_VERIFIED_ON, citationCountryFor, citationSitesFor } from "./citation-sites";
import { DFS_COUNTRY_LOCATIONS } from "./dfs-locations";

describe("citation sites config", () => {
  it("has unique keys", () => {
    const keys = CITATION_SITES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("uses https urls and a source url for every site", () => {
    for (const s of CITATION_SITES) {
      expect(s.claimUrl, s.key).toMatch(/^https:\/\/[^\s]+$/);
      expect(s.sourceUrl, s.key).toMatch(/^https:\/\/[^\s]+$/);
      expect(s.countries.length, s.key).toBeGreaterThan(0);
      for (const c of s.countries) expect(CITATION_COUNTRIES, `${s.key} ${c}`).toContain(c);
    }
  });
  it("has at least 20 sites in every country, and prints the counts", () => {
    const counts = Object.fromEntries(CITATION_COUNTRIES.map((c) => [c, citationSitesFor(c).length]));
    console.log("citation sites per country", counts);
    expect(CITATION_COUNTRIES.length).toBe(Object.keys(DFS_COUNTRY_LOCATIONS.codes).length);
    for (const c of CITATION_COUNTRIES) expect(counts[c], c).toBeGreaterThanOrEqual(20);
  });
  it("carries a verification date", () => {
    expect(CITATION_SITES_VERIFIED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("canary: Bing Places is listed for every country", () => {
    for (const c of CITATION_COUNTRIES) expect(citationSitesFor(c).map((s) => s.key), c).toContain("bing-places");
  });
  it("falls back to the US list for an empty or unlisted country", () => {
    expect(citationCountryFor(null)).toBe("US");
    expect(citationCountryFor("  ")).toBe("US");
    expect(citationCountryFor("zz")).toBe("US");
    expect(citationCountryFor("in")).toBe("IN");
    expect(citationSitesFor(undefined)).toEqual(citationSitesFor("US"));
  });
});
