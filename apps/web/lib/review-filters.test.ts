import { describe, expect, it, vi } from "vitest";
import { dayRange, exportInputFromParams, parseQuery, parseSort } from "./review-filters";
import { makeTimeFormat } from "./time-format";

const utc = makeTimeFormat({ zones: [], workspaceId: null });
const ist = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

const q = (s: string) => new URLSearchParams(s);

describe("exportInputFromParams", () => {
  it("keeps the filters and has no columns by default (the API default applies)", () => {
    const i = exportInputFromParams(q("ws=w1&loc=l1&rating=1&rating=2&replied=no&from=2026-09-01&to=2026-09-30"), utc);
    expect(i).toMatchObject({ workspaceId: "w1", locationIds: ["l1"], ratings: [1, 2], replied: false, from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
    expect(i.columns).toBeUndefined();
  });
  it("carries the topic and sentiment filters, and drops unknown ones", () => {
    expect(exportInputFromParams(q("topic=wait_time&sentiment=negative"), utc)).toMatchObject({ topic: "wait_time", sentiment: "negative" });
    expect(exportInputFromParams(q("topic=weather&sentiment=angry"), utc)).toMatchObject({ topic: undefined, sentiment: undefined });
  });
  it("cols=1 with col values picks columns, and cols=1 with none is empty (core refuses it)", () => {
    expect(exportInputFromParams(q("cols=1&col=date&col=stars&col=bogus"), utc).columns).toEqual(["date", "stars"]);
    expect(exportInputFromParams(q("cols=1"), utc).columns).toEqual([]);
  });
  it("scope=year ignores the page filters, keeps the workspace, and starts 365 days back", () => {
    vi.useFakeTimers({ now: new Date("2026-10-19T12:00:00Z") });
    try {
      const i = exportInputFromParams(q("scope=year&ws=w1&loc=l1&rating=1&replied=no"), utc);
      expect(i).toEqual({ workspaceId: "w1", from: "2025-10-19T00:00:00.000Z" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("scope=year counts back from the client's today, from that day's start in its zone", () => {
    vi.useFakeTimers({ now: new Date("2026-10-19T20:00:00Z") }); // already the 20th in IST
    try {
      expect(exportInputFromParams(q("scope=year&ws=w"), ist)).toEqual({ workspaceId: "w", from: "2025-10-19T18:30:00.000Z" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dayRange", () => {
  it("is the client's calendar days: from inclusive, to through the whole day", () => {
    expect(dayRange("UTC", "2026-09-01", "2026-09-30")).toEqual({ from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
    expect(dayRange("Asia/Kolkata", "2026-09-01", "2026-09-30")).toEqual({ from: "2026-08-31T18:30:00.000Z", to: "2026-09-30T18:30:00.000Z" });
  });
  it("ignores values that are not a day", () => {
    expect(dayRange("UTC", "x", undefined)).toEqual({});
  });
});

describe("search and sort params", () => {
  it("parseQuery trims, caps at 100 and drops blanks", () => {
    expect(parseQuery("  insurance ")).toBe("insurance");
    expect(parseQuery("   ")).toBeUndefined();
    expect(parseQuery(undefined)).toBeUndefined();
    expect(parseQuery("x".repeat(150))).toHaveLength(100);
  });
  it("parseSort keeps the three non-default sorts and drops newest and junk", () => {
    expect(parseSort("oldest")).toBe("oldest");
    expect(parseSort("rating_high")).toBe("rating_high");
    expect(parseSort("rating_low")).toBe("rating_low");
    expect(parseSort("newest")).toBeUndefined();
    expect(parseSort("bogus")).toBeUndefined();
  });
  it("the export carries q and sort", () => {
    expect(exportInputFromParams(q("q=insurance&sort=rating_low"), utc)).toMatchObject({ q: "insurance", sort: "rating_low" });
    expect(exportInputFromParams(q("ws=w1"), utc)).toMatchObject({ q: undefined, sort: undefined });
  });
});
