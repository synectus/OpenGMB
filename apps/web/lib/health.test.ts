import { describe, expect, it } from "vitest";
import { makeTimeFormat } from "./time-format";
import {
  averagePercent,
  commonFailing,
  exclusionNote,
  groupTitle,
  pageNote,
  pageWindow,
  parsePage,
  parseShow,
  scoreLine,
  scoreTone,
  showCounts,
  skippedLine,
  summaryLine,
  thresholdsNote,
  topFailing,
  visibleChecks,
  type CheckRow,
} from "./health";

const row = (id: string, status: CheckRow["status"], importance: CheckRow["importance"] = "important"): CheckRow => ({
  id,
  title: id,
  importance,
  status,
  detail: "",
  fix: null,
  skipped: status === "skipped" ? { byName: "Priya", at: "2026-10-15T10:00:00.000Z" } : null,
});
const checks = [row("a", "pass"), row("b", "fail", "necessary"), row("c", "fail"), row("d", "skipped"), row("e", "unknown")];


const utc = makeTimeFormat({ zones: [{ id: "w", timeZone: "UTC", dateFormat: "YYYY-MM-DD" }], workspaceId: "w" });
const ist = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

describe("checklist", () => {
  it("pills count all, failing and skipped; unknown counts in all only", () => {
    expect(showCounts(checks)).toEqual({ all: 5, failing: 2, skipped: 1 });
    expect(visibleChecks(checks, "failing").map((c) => c.id)).toEqual(["b", "c"]);
    expect(visibleChecks(checks, "skipped").map((c) => c.id)).toEqual(["d"]);
    expect(visibleChecks(checks, "all")).toHaveLength(5);
    expect(parseShow("failing")).toBe("failing");
    expect(parseShow("x")).toBe("all");
  });
  it("score line and group titles", () => {
    expect(scoreLine({ passed: 17, total: 20 }, 1)).toBe("17 of 20 checks pass · 1 necessary failing");
    expect(scoreLine({ passed: 20, total: 20 }, 0)).toBe("20 of 20 checks pass");
    expect(groupTitle("Necessary", 7)).toBe("Necessary (7)");
  });
  it("score bands: 80 and up good, 50 to 79 warn, below 50 bad", () => {
    expect([100, 80, 79, 50, 49, 0].map(scoreTone)).toEqual(["good", "good", "warn", "warn", "bad", "bad"]);
  });
  it("skipped line and thresholds come from data and config", () => {
    expect(skippedLine({ byName: "Priya", at: "2026-10-15T10:00:00.000Z" }, utc)).toBe(
      "Skipped by Priya on 2026-10-15 · left out of the score",
    );
    expect(skippedLine({ byName: null, at: "2026-10-15T10:00:00.000Z" }, ist)).toBe(
      "Skipped by a team member on 15/10/2026 · left out of the score",
    );
    expect(thresholdsNote({ minPhotos: 10, recentPhotoDays: 30, recentPostDays: 7, minAverageRating: 4 })).toBe(
      "Thresholds are Synectus's own rules of thumb, not Google limits: 10 photos, a photo within 30 days, a post within 7 days, an average of 4.0 or higher.",
    );
  });
});

describe("org view", () => {
  const f = (title: string, importance: "necessary" | "important" | "nice") => ({ id: title, title, importance });
  const locs = [
    { name: "Rivermoor Del Mar", score: { percent: 45 }, failing: [f("Verified, in good standing", "necessary"), f("No unreplied reviews", "necessary"), f("Phone number", "necessary"), f("A recent photo", "important")] },
    { name: "Rivermoor North", score: { percent: 70 }, failing: [f("No unreplied reviews", "necessary"), f("A recent photo", "important")] },
    { name: "Rivermoor Main St", score: { percent: 85 }, failing: [f("No unreplied reviews", "necessary"), f("A recent photo", "important"), f("Website link has UTM tracking", "nice")] },
    { name: "Rivermoor Medical Plaza", score: { percent: 90 }, failing: [f("Services listed", "nice")] },
  ];
  it("summary line, average and the three chips per row", () => {
    expect(averagePercent(locs)).toBe(73);
    expect(averagePercent([])).toBeNull();
    expect(summaryLine(4, 6, 73)).toBe("4 of 6 locations checked · average 73%");
    expect(summaryLine(0, 1, null)).toBe("0 of 1 location checked");
    expect(topFailing(locs[0]!.failing).map((x) => x.title)).toEqual([
      "Verified, in good standing",
      "No unreplied reviews",
      "Phone number",
    ]);
  });
  it("most common failing checks, most locations first, then by title, at most 4", () => {
    expect(commonFailing(locs)).toEqual([
      { title: "A recent photo", count: "3 locations" },
      { title: "No unreplied reviews", count: "3 locations" },
      { title: "Phone number", count: "1 location" },
      { title: "Services listed", count: "1 location" },
    ]);
  });
  it("explains which locations are not checked", () => {
    const l = (name: string, o: { status?: "active" | "inactive"; needsRelink?: boolean; googleLocationId?: string | null }) => ({
      name,
      status: o.status ?? "active",
      needsRelink: o.needsRelink ?? false,
      googleLocationId: o.googleLocationId === undefined ? "locations/1" : o.googleLocationId,
    });
    expect(
      exclusionNote([l("Rivermoor Main St", {}), l("Rivermoor South", { needsRelink: true }), l("Rivermoor Orchard Hwy", { status: "inactive" })]),
    ).toBe("Rivermoor South is not linked to Google and Rivermoor Orchard Hwy is inactive, so they are not checked.");
    expect(exclusionNote([l("A", { googleLocationId: null }), l("B", { needsRelink: true })])).toBe(
      "A and B are not linked to Google, so they are not checked.",
    );
    expect(exclusionNote([l("A", { status: "inactive" })])).toBe("A is inactive, so it is not checked.");
    expect(exclusionNote([l("A", {}), l("B", {})])).toBeNull();
    const many = ["A", "B", "C", "D"].map((n) => l(n, { status: "inactive" }));
    expect(exclusionNote(many)).toBe("4 locations are inactive, so they are not checked.");
  });
  it("pages: the window, the note and bad input (U8)", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("3")).toBe(3);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-2")).toBe(1);
    expect(parsePage("x")).toBe(1);
    expect(pageWindow(1, 25, 500)).toEqual({ page: 1, offset: 0, from: 1, to: 25, pages: 20, total: 500, hasPrev: false, hasNext: true });
    expect(pageWindow(20, 25, 500)).toEqual({ page: 20, offset: 475, from: 476, to: 500, pages: 20, total: 500, hasPrev: true, hasNext: false });
    // A page past the end falls back to the last one, so a stale link never shows an empty list.
    expect(pageWindow(99, 25, 31)).toMatchObject({ page: 2, offset: 25, from: 26, to: 31, pages: 2 });
    expect(pageWindow(1, 25, 0)).toMatchObject({ page: 1, from: 0, to: 0, pages: 1, hasNext: false });
    expect(pageNote(pageWindow(2, 25, 500), 25)).toBe(
      "Locations 26 to 50 of 500, worst score first within this page. Each page checks 25 locations, by name.",
    );
    expect(pageNote(pageWindow(1, 25, 4), 25)).toBe("4 locations, worst score first.");
  });
});
