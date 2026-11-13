import { describe, expect, it } from "vitest";
import { FIRST_SCAN, firstScanHref, firstScanInput } from "./first-scan";

describe("firstScanInput", () => {
  it("builds a quick scan without coordinates, using the first-scan grid", () => {
    expect(firstScanInput("ws-1", { placeId: "ChIJx", name: "Joe's Plumbing", address: "1 Main St" }, " plumber ")).toEqual({
      workspaceId: "ws-1",
      businessName: "Joe's Plumbing",
      placeId: "ChIJx",
      keyword: "plumber",
      gridSize: FIRST_SCAN.gridSize,
      radiusM: FIRST_SCAN.radiusM,
      speed: FIRST_SCAN.speed,
    });
  });
  it("uses the quick-scan form's defaults", () => {
    expect(FIRST_SCAN).toEqual({ gridSize: 5, radiusM: 2000, speed: "standard" });
  });
  it("links to the scan page", () => {
    expect(firstScanHref("c1", "r1")).toBe("/geogrid?view=scan&config=c1&run=r1");
    expect(firstScanHref("c1")).toBe("/geogrid?view=scan&config=c1");
  });
});
