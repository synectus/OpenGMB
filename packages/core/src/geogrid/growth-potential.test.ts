import { describe, expect, it } from "vitest";
import { GROWTH_POTENTIAL_CONFIG } from "../config/growth-potential";
import { estimateGrowthPotential } from "./growth-potential";

describe("estimateGrowthPotential", () => {
  it("is zero when every point is already in the top 3", () => {
    expect(estimateGrowthPotential([1, 2, 3, 1], 500)).toEqual({ low: 0, high: 0 });
  });
  it("uses the whole gap when nothing is found", () => {
    // 100 actions x 2.9% = 2.9 -> floor 2; x 10.7333% = 10.73 -> ceil 11
    expect(estimateGrowthPotential([null, null, null, null], 100)).toEqual({ low: 2, high: 11 });
  });
  it("scales by the share of points outside the top 3, treating rank 4 and 20+ alike", () => {
    expect(estimateGrowthPotential([1, 2, 4, null], 1000)).toEqual({ low: 14, high: 54 });
  });
  it("is null with no stored performance data or no collected points", () => {
    expect(estimateGrowthPotential([5, null], null)).toBeNull();
    expect(estimateGrowthPotential([], 100)).toBeNull();
  });
  it("is 0 to 0 for a location with stored data but no actions", () => {
    expect(estimateGrowthPotential([null], 0)).toEqual({ low: 0, high: 0 });
  });
  it("keeps low <= high and never exceeds the best pack share of the location's actions", () => {
    const e = estimateGrowthPotential([null, 9, 12], 400)!;
    expect(e.low).toBeLessThanOrEqual(e.high);
    expect(e.high).toBeLessThanOrEqual(Math.ceil((400 * GROWTH_POTENTIAL_CONFIG.packClickSharePercent[1].value) / 100));
  });
  it("every configured share carries a source and a verified date", () => {
    for (const s of Object.values(GROWTH_POTENTIAL_CONFIG.packClickSharePercent)) {
      expect(s.sourceUrl).toMatch(/^https:\/\//);
      expect(s.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
