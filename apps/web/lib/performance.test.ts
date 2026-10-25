import { describe, expect, it } from "vitest";
import {
  deviceSplit,
  keywordUsers,
  matchPreset,
  monthSpan,
  outcomeSentence,
  performanceHref,
  periodPhrase,
  presetRange,
  tileDelta,
  type KpiDelta,
} from "./performance";
import { makeTimeFormat } from "./time-format";

const utc = makeTimeFormat({ zones: [], workspaceId: null });
const ist = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

const k = (key: string, total: number, previousTotal: number): KpiDelta => ({
  key,
  total,
  previousTotal,
  delta: total - previousTotal,
  deltaPct: previousTotal === 0 ? null : (total - previousTotal) / previousTotal,
});

describe("tileDelta", () => {
  it("prints whole percents with a direction", () => {
    expect(tileDelta(k("calls", 412, 368))).toEqual({ text: "Up 12%", tone: "good", arrow: "up" });
    expect(tileDelta(k("websiteClicks", 1068, 1113))).toEqual({ text: "Down 4%", tone: "bad", arrow: "down" });
  });
  it("says No change 0% before no earlier data, so two zeros are no change", () => {
    expect(tileDelta(k("calls", 412, 412))).toEqual({ text: "No change 0%", tone: "neutral", arrow: "flat" });
    expect(tileDelta(k("calls", 0, 0)).text).toBe("No change 0%");
    expect(tileDelta(k("calls", 38, 0))).toEqual({ text: "no earlier data", tone: "none", arrow: null });
  });
  it("never prints Up 0% for a real change", () => {
    expect(tileDelta(k("calls", 1001, 1000)).text).toBe("Up <1%");
    expect(tileDelta(k("calls", 999, 1000)).text).toBe("Down <1%");
  });
});

describe("outcomeSentence", () => {
  const p = "In the last 30 days";
  const kpis = (calls: [number, number], dirs: [number, number], web: [number, number]) => [
    k("calls", ...calls),
    k("directions", ...dirs),
    k("websiteClicks", ...web),
  ];
  it("matches the canvas when both rise and clicks fall", () => {
    expect(outcomeSentence(kpis([412, 368], [655, 601], [1068, 1113]), p, 30)).toBe(
      "In the last 30 days, 412 people called and 655 asked for directions: 12% and 9% more than the 30 days before. Website clicks fell 4%.",
    );
  });
  it("both fall", () => {
    expect(outcomeSentence(kpis([90, 100], [45, 50], [10, 10]), p, 30)).toBe(
      "In the last 30 days, 90 people called and 45 asked for directions: 10% and 10% fewer than the 30 days before.",
    );
  });
  it("mixed directions are spelled out one by one", () => {
    expect(outcomeSentence(kpis([110, 100], [45, 50], [12, 10]), p, 30)).toBe(
      "In the last 30 days, 110 people called and 45 asked for directions. Compared with the 30 days before, calls rose 10% and direction requests fell 10%. Website clicks rose 20%.",
    );
    expect(outcomeSentence(kpis([110, 100], [45, 45], [0, 0]), p, 30)).toBe(
      "In the last 30 days, 110 people called and 45 asked for directions. Compared with the 30 days before, calls rose 10% and direction requests did not change.",
    );
  });
  it("no earlier data, no change, all zero, and one person", () => {
    expect(outcomeSentence(kpis([12, 0], [3, 0], [5, 0]), p, 30)).toBe(
      "In the last 30 days, 12 people called and 3 asked for directions. There is no earlier data to compare with.",
    );
    expect(outcomeSentence(kpis([5, 5], [2, 2], [1, 1]), p, 7)).toBe(
      "In the last 30 days, 5 people called and 2 asked for directions, the same as the 7 days before.",
    );
    expect(outcomeSentence(kpis([0, 0], [0, 0], [0, 0]), p, 30)).toBe(
      "In the last 30 days, Google recorded no calls or direction requests, the same as the 30 days before.",
    );
    expect(outcomeSentence(kpis([1, 0], [0, 3], [0, 0]), p, 30)).toBe(
      "In the last 30 days, 1 person called and 0 asked for directions. Compared with the 30 days before, calls had no earlier data and direction requests fell 100%.",
    );
  });
  it("tiny changes say less than 1%; missing KPIs give null", () => {
    expect(outcomeSentence(kpis([1001, 1000], [2002, 2000], [0, 0]), p, 30)).toContain(
      "less than 1% and less than 1% more than the 30 days before.",
    );
    expect(outcomeSentence([k("calls", 1, 1)], p, 30)).toBeNull();
  });
});

describe("periodPhrase, presets, month span", () => {
  const today = "2026-10-18";
  it("names the last 30 days, a whole month, or the dates", () => {
    expect(periodPhrase({ from: "2026-09-18", to: "2026-10-17" }, today, utc)).toBe("In the last 30 days");
    expect(periodPhrase({ from: "2026-09-01", to: "2026-09-30" }, today, utc)).toBe("In September 2026");
    expect(periodPhrase({ from: "2024-02-01", to: "2024-02-29" }, today, utc)).toBe("In February 2024");
    expect(periodPhrase({ from: "2026-09-03", to: "2026-10-01" }, today, utc)).toBe("From 2026-09-03 to 2026-10-01");
    expect(periodPhrase({ from: "2026-09-03", to: "2026-10-01" }, today, ist)).toBe("From 03/09/2026 to 01/10/2026");
  });
  it("presets end yesterday (of the given day); last month is the calendar month", () => {
    expect(presetRange("30", today)).toEqual({ from: "2026-09-18", to: "2026-10-17" });
    expect(presetRange("90", today)).toEqual({ from: "2026-07-20", to: "2026-10-17" });
    expect(presetRange("month", "2026-03-01")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(presetRange("month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(matchPreset({ from: "2026-07-20", to: "2026-10-17" }, today)).toBe("90");
    expect(matchPreset({ from: "2026-07-21", to: "2026-10-17" }, today)).toBeNull();
  });
  it("monthSpan names the keyword months", () => {
    expect(monthSpan(["2026-07", "2026-08", "2026-09"])).toBe("July to September 2026");
    expect(monthSpan(["2025-12", "2026-01"])).toBe("December 2025 to January 2026");
    expect(monthSpan(["2026-09"])).toBe("September 2026");
    expect(monthSpan([])).toBe("");
  });
});

describe("deviceSplit", () => {
  const m = (metric: string, total: number) => ({ metric, total });
  it("splits Maps and Search into mobile and desktop with whole percents that add to 100", () => {
    const rows = deviceSplit([
      m("BUSINESS_IMPRESSIONS_MOBILE_MAPS", 14920),
      m("BUSINESS_IMPRESSIONS_DESKTOP_MAPS", 3500),
      m("BUSINESS_IMPRESSIONS_MOBILE_SEARCH", 6240),
      m("BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", 3070),
      m("CALL_CLICKS", 412),
    ]);
    expect(rows[0]).toMatchObject({ name: "Google Maps", total: 18420, mobilePct: 81, desktopPct: 19 });
    expect(rows[0]!.label).toBe("Google Maps 18,420: mobile 14,920 (81%), desktop 3,500 (19%)");
    expect(rows[1]).toMatchObject({ name: "Google Search", total: 9310, mobilePct: 67, desktopPct: 33 });
  });
  it("has no percentages when there were no impressions", () => {
    const [maps] = deviceSplit([]);
    expect(maps).toMatchObject({ total: 0, mobilePct: null, desktopPct: null, label: "Google Maps: no impressions" });
  });
});

describe("keywordUsers", () => {
  it("prints exact, floor and below", () => {
    expect(keywordUsers({ value: 1240, isLowerBound: false, hiddenBelow: 0 })).toBe("1,240");
    expect(keywordUsers({ value: 120, isLowerBound: true, hiddenBelow: 15 })).toBe(
      "120+ (some months below Google's threshold)",
    );
    expect(keywordUsers({ value: 0, isLowerBound: true, hiddenBelow: 15 })).toBe("below 15");
  });
});

describe("scope and hrefs", () => {
  const W = "11111111-1111-4111-8111-111111111111";
  it("performanceHref keeps only what is set, ws for a deep link", () => {
    expect(performanceHref({})).toBe("/performance");
    const u = new URL(performanceHref({ ws: W, from: "2026-09-18", to: "2026-10-17", kpi: "calls" }), "http://x");
    expect(Object.fromEntries(u.searchParams)).toEqual({ ws: W, from: "2026-09-18", to: "2026-10-17", kpi: "calls" });
  });
});
