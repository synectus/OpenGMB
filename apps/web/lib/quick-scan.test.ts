import { describe, expect, it } from "vitest";
import { averageText, checkPlaceId, compareScans, gridShort, scanRows, type ScanConfig, type ScanRun } from "./quick-scan";
import { makeTimeFormat } from "./time-format";

const utc = makeTimeFormat({ zones: [], workspaceId: null });
const ist = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

const cfg = (id: string, name: string, size = 5, radiusM = 2000): ScanConfig => ({
  id,
  targetName: name,
  keywords: ["chiropractor rivermoor"],
  gridSize: size,
  radiusM,
});
const run = (
  id: string,
  configId: string,
  createdAt: string,
  avg: number | null,
  found: number | null = 0.8,
  status: ScanRun["status"] = "done",
): ScanRun => ({
  id,
  configId,
  keyword: "chiropractor rivermoor",
  status,
  createdAt,
  finishedAt: status === "done" ? createdAt : null,
  summary: { averageRank: avg, foundShare: found },
});

describe("text", () => {
  it("grid in short form, kilometres from 1,000 m", () => {
    expect(gridShort(5, 2000)).toBe("5x5, 2 km");
    expect(gridShort(7, 3500)).toBe("7x7, 3.5 km");
    expect(gridShort(3, 800)).toBe("3x3, 800 m");
  });
  it("average rank, or 20+ when the business was found nowhere", () => {
    expect(averageText({ averageRank: 9.4, foundShare: 0.76 }, "done")).toBe("9.4");
    expect(averageText({ averageRank: 21, foundShare: 0 }, "done")).toBe("20+ (not found)");
    expect(averageText({ averageRank: null, foundShare: null }, "running")).toBe("-");
  });
  it("checks the place id shape only", () => {
    expect(checkPlaceId("ChIJ_prospectA_0123456789")).toBeNull();
    expect(checkPlaceId("")).toBe("Paste the business's Google place id.");
    expect(checkPlaceId("has spaces in it")).toBe("That does not look like a Google place id.");
  });
});

describe("history", () => {
  const configs = [cfg("a", "[PROSPECT A] Chiropractic"), cfg("b", "[PROSPECT B] Law Office", 7, 3000)];
  const runs = [
    run("a2", "a", "2026-10-17T15:40:00Z", 9.4),
    run("b1", "b", "2026-10-02T12:30:00Z", 6.1),
    run("a1", "a", "2026-09-17T10:05:00Z", 11.2),
    run("x", "gone", "2026-09-01T00:00:00Z", 5),
  ];
  it("one row per run, newest first, joined to its scan; orphans dropped (denominator)", () => {
    const rows = scanRows(configs, runs, utc);
    expect(rows.map((r) => r.runId)).toEqual(["a2", "b1", "a1"]);
    expect(rows[0]).toMatchObject({
      configId: "a",
      business: "[PROSPECT A] Chiropractic",
      keyword: "chiropractor rivermoor",
      grid: "5x5, 2 km",
      average: "9.4",
      scanned: "2026-10-17 15:40",
      runCount: 2,
    });
    expect(scanRows(configs, runs, ist)[0]!.scanned).toBe("17/10/2026 21:10");
  });
  it("compares the two newest finished runs of a scan", () => {
    expect(compareScans(runs.filter((r) => r.configId === "a"), utc)).toEqual({
      lines: ["2026-09-17 average 11.2", "2026-10-17 average 9.4"],
      delta: { label: "Up 1.8", tone: "good" },
    });
    expect(compareScans([runs[1]!], utc)).toBeNull();
    expect(compareScans([runs[0]!, run("p", "a", "2026-10-18T00:00:00Z", null, null, "running")], utc)).toBeNull();
  });
});
