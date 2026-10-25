import { describe, expect, it } from "vitest";
import {
  deniedCopy,
  expiryLine,
  formatSize,
  keywordNote,
  shareKeywordUsers,
  shareSentence,
  shareTiles,
  subline,
} from "./share-page";
import { makeTimeFormat } from "./time-format";

const utc = makeTimeFormat({ zones: [], workspaceId: null });
const ist = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

const kpi = (key: string, label: string, total: number, previousTotal: number) => ({
  key,
  label,
  total,
  previousTotal,
  delta: total - previousTotal,
  deltaPct: previousTotal === 0 ? null : (total - previousTotal) / previousTotal,
});
const KPIS = [
  kpi("impressionsTotal", "Profile impressions", 27730, 26922),
  kpi("impressionsMaps", "Impressions on Google Maps", 18420, 17377),
  kpi("impressionsSearch", "Impressions on Google Search", 9310, 9598),
  kpi("calls", "Calls", 412, 368),
  kpi("websiteClicks", "Website clicks", 1068, 1113),
  kpi("directions", "Direction requests", 655, 601),
];
const content = {
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  workspaceName: "Rivermoor Pain Clinic",
  locationCount: 6,
  kpis: KPIS,
  keywordMonths: ["2026-07", "2026-08", "2026-09"],
};

describe("share page logic", () => {
  it("orders the five tiles like the canvas, with deltas", () => {
    expect(shareTiles(KPIS).map((t) => [t.label, t.value, t.delta.text])).toEqual([
      ["Calls", "412", "Up 12%"],
      ["Website clicks", "1,068", "Down 4%"],
      ["Direction requests", "655", "Up 9%"],
      ["Impressions on Google Maps", "18,420", "Up 6%"],
      ["Impressions on Google Search", "9,310", "Down 3%"],
    ]);
  });
  it("says what it means with the equal-length comparison, never 'the last 30 days'", () => {
    expect(shareSentence(content, utc)).toBe(
      "In September 2026, 412 people called and 655 asked for directions: 12% and 9% more than the 30 days before. Website clicks fell 4%.",
    );
    expect(shareSentence({ ...content, periodStart: "2026-09-18", periodEnd: "2026-10-17" }, utc)).toMatch(
      /^From 2026-09-18 to 2026-10-17, /,
    );
  });
  it("subline, keyword note, sizes, expiry", () => {
    expect(subline(content, utc)).toBe("Rivermoor Pain Clinic · 6 locations · 2026-09-01 to 2026-09-30");
    expect(subline(content, ist)).toBe("Rivermoor Pain Clinic · 6 locations · 01/09/2026 to 30/09/2026");
    expect(subline({ ...content, locationCount: 1 }, utc)).toContain("· 1 location ·");
    expect(keywordNote(content.keywordMonths)).toBe("July to September 2026, unique users. Google hides small counts.");
    expect(formatSize(1_258_291)).toBe("PDF, 1.2 MB");
    expect(formatSize(52_000)).toBe("PDF, 51 KB");
    expect(formatSize(null)).toBeNull();
    expect(expiryLine("2026-10-31T09:00:00.000Z", "Synectus", utc)).toBe(
      "This link expires on 2026-10-31. It was shared by Synectus.",
    );
    expect(expiryLine("2026-10-31T21:00:00.000Z", "Synectus", ist)).toBe(
      "This link expires on 01/11/2026. It was shared by Synectus.",
    );
  });
  it("keyword values are short on the share page", () => {
    expect(shareKeywordUsers({ value: 1240, isLowerBound: false, hiddenBelow: 0 })).toBe("1,240");
    expect(shareKeywordUsers({ value: 120, isLowerBound: true, hiddenBelow: 15 })).toBe("120+");
    expect(shareKeywordUsers({ value: 0, isLowerBound: true, hiddenBelow: 15 })).toBe("Below 15");
  });
  it("denied copy names the agency only for links that existed", () => {
    expect(deniedCopy("expired", "Synectus")).toEqual({ title: "This link has expired", body: "Ask Synectus for a new link." });
    expect(deniedCopy("revoked", "Synectus")).toEqual({ title: "This link was turned off", body: "Ask Synectus for a new link." });
    expect(deniedCopy("invalid", null)).toEqual({ title: "This link does not work", body: "Check that you copied the whole address." });
  });
});
