import { describe, expect, it } from "vitest";
import { growthPotentialView } from "./growth-potential";

const perf = { lastDataDate: "2026-10-23", actions: 200, from: "2026-09-24", to: "2026-10-23" };
const pt = (rank: number | null, pending = false) => ({ rank, pending });
const base = { sample: false, targetName: "Smile Dental", points: [pt(null), pt(5), pt(1), pt(2)], performance: perf };

describe("growthPotentialView", () => {
  it("shows a range, the basis and the disclaimer for a live run", () => {
    // 200 actions x 0.5 outside x 2.9% = 2.9 -> 2; x 10.7333% = 10.73 -> 11
    const v = growthPotentialView(base);
    expect(v.kind).toBe("estimate");
    if (v.kind !== "estimate") return;
    expect(v.text).toBe(
      "If Smile Dental ranked in the top 3 across this grid, you could expect about 2 to 11 more calls, website visits and direction requests a month.",
    );
    expect(v.basis).toContain("200 calls, website visits and direction requests");
    expect(v.basis).toContain("2026-09-24 to 2026-10-23");
    expect(v.disclaimer).toBe("Estimate, not a promise.");
  });
  it("shows only a note for a sample run, whatever else is true", () => {
    const v = growthPotentialView({ ...base, sample: true });
    expect(v).toEqual({ kind: "note", text: expect.stringContaining("sample") });
  });
  it("explains the missing performance data instead of inventing a number", () => {
    for (const performance of [null, { ...perf, lastDataDate: null }]) {
      const v = growthPotentialView({ ...base, performance });
      expect(v.kind).toBe("note");
      expect(v.kind === "note" && v.text).toContain("no stored Google performance data");
    }
  });
  it("says so when the location has data but no actions", () => {
    const v = growthPotentialView({ ...base, performance: { ...perf, actions: 0 } });
    expect(v.kind === "note" && v.text).toContain("no calls");
  });
  it("says there is no gap when every collected point is in the top 3", () => {
    const v = growthPotentialView({ ...base, points: [pt(1), pt(3), pt(null, true)] });
    expect(v.kind === "note" && v.text).toContain("top 3 at every point");
  });
  it("waits for collected points", () => {
    const v = growthPotentialView({ ...base, points: [pt(null, true)] });
    expect(v.kind === "note" && v.text).toContain("collected");
  });
  it("says 'up to' when the low end rounds to zero", () => {
    const v = growthPotentialView({ ...base, performance: { ...perf, actions: 10 }, points: [pt(null), pt(null)] });
    expect(v.kind === "estimate" && v.text).toContain("up to 2 more");
  });
});
