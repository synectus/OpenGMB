import { describe, expect, it } from "vitest";
import { SEO_PRICES, SEO_KEYWORDS } from "../../config/seo";
import { cacheKey, researchEstimateUsd } from "./estimate";

describe("keyword research estimate", () => {
  it("every external price has a source URL and a verified-on date", () => {
    const prices = Object.values(SEO_PRICES);
    expect(prices.length).toBeGreaterThan(0);
    for (const p of prices) {
      expect(p.sourceUrl).toMatch(/^https:\/\/dataforseo\.com\/pricing\//);
      expect(p.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it("is an upper bound: 2 Labs tasks with half the rows each plus the seed row, plus one Ads task for a city", () => {
    const labs = SEO_PRICES.labs;
    const national = researchEstimateUsd({ rows: 150, city: false });
    expect(national).toBeCloseTo(2 * labs.perTaskUsd + 2 * (75 + 1) * labs.perRowUsd, 6);
    expect(researchEstimateUsd({ rows: 150, city: true })).toBeCloseTo(national + SEO_PRICES.googleAdsLive.perTaskUsd, 6);
    expect(researchEstimateUsd({ rows: 151, city: false })).toBeCloseTo(2 * labs.perTaskUsd + 2 * (76 + 1) * labs.perRowUsd, 6);
  });
  it("caches by workspace, normalized seed, market and rows", () => {
    const a = cacheKey({ workspaceId: "w", seed: " Plumber  Austin ", countryIso: "us", city: "Austin,Texas,United States", rows: 150 });
    expect(a).toBe(cacheKey({ workspaceId: "w", seed: "plumber austin", countryIso: "US", city: "Austin,Texas,United States", rows: 150 }));
    expect(a).not.toBe(cacheKey({ workspaceId: "w", seed: "plumber austin", countryIso: "US", city: null, rows: 150 }));
    expect(SEO_KEYWORDS.maxRows).toBe(300);
  });
});
