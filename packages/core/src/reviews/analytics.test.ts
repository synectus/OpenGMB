import { describe, expect, it } from "vitest";
import {
  computeAnalytics,
  median,
  monthlyOf,
  monthsBetween,
  starCounts,
  totalsOf,
  trendOf,
  type AnalyticsRow,
} from "./analytics";

const at = (day: string) => new Date(`${day}T12:00:00Z`);
const row = (day: string, o: Partial<AnalyticsRow> = {}): AnalyticsRow => ({
  locationId: "L1",
  createTime: at(day),
  rating: 5,
  replied: true,
  replyHours: 10,
  ...o,
});

describe("totalsOf", () => {
  it("canary: known rows give known numbers", () => {
    const t = totalsOf([
      row("2026-10-01", { rating: 5, replyHours: 10 }),
      row("2026-10-02", { rating: 5, replyHours: 20 }),
      row("2026-10-03", { rating: 4, replyHours: 30 }),
      row("2026-10-04", { rating: 1, replied: false, replyHours: null }),
    ]);
    expect(t).toEqual({
      count: 4,
      rated: 4,
      avgRating: 3.8,
      replied: 3,
      replyRate: 0.75,
      medianReplyHours: 20,
      needsReply: 1,
    });
  });
  it("no rows is all zeros and nulls, never NaN", () => {
    expect(totalsOf([])).toEqual({
      count: 0,
      rated: 0,
      avgRating: null,
      replied: 0,
      replyRate: null,
      medianReplyHours: null,
      needsReply: 0,
    });
  });
  it("star-less reviews count as reviews but not in the average", () => {
    const t = totalsOf([row("2026-10-01", { rating: null }), row("2026-10-02", { rating: 4 })]);
    expect(t.count).toBe(2);
    expect(t.rated).toBe(1);
    expect(t.avgRating).toBe(4);
  });
  it("a row that is not replied never feeds the median", () => {
    const t = totalsOf([row("2026-10-01", { replied: false, replyHours: 999 }), row("2026-10-02", { replyHours: 6 })]);
    expect(t.medianReplyHours).toBe(6);
  });
});

describe("median", () => {
  it("odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([10, 20, 30, 40])).toBe(25);
    expect(median([])).toBeNull();
  });
});

describe("monthsBetween", () => {
  it("12 calendar months including the partial last one", () => {
    const m = monthsBetween(new Date("2025-11-01T00:00:00Z"), new Date("2026-10-20T00:00:00Z"));
    expect(m).toHaveLength(12);
    expect(m[0]).toBe("2025-11");
    expect(m[11]).toBe("2026-10");
  });
  it("`to` is exclusive: ending exactly on the 1st does not touch that month", () => {
    const m = monthsBetween(new Date("2026-09-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
    expect(m).toEqual(["2026-09"]);
  });
});

describe("monthlyOf and starCounts", () => {
  it("buckets by UTC month; low means 1 to 3 stars; empty months are zero and null", () => {
    const rows = [row("2026-10-02", { rating: 5 }), row("2026-10-09", { rating: 2 }), row("2026-08-30", { rating: 4 })];
    expect(monthlyOf(rows, ["2026-08", "2026-09", "2026-10"])).toEqual([
      { month: "2026-08", total: 1, low: 0, avg: 4 },
      { month: "2026-09", total: 0, low: 0, avg: null },
      { month: "2026-10", total: 2, low: 1, avg: 3.5 },
    ]);
    expect(starCounts(rows)).toEqual([
      { star: 5, count: 1 },
      { star: 4, count: 1 },
      { star: 3, count: 0 },
      { star: 2, count: 1 },
      { star: 1, count: 0 },
    ]);
  });
});

describe("trendOf", () => {
  it("up, down, flat, and none with fewer than two points", () => {
    expect(trendOf([4.0, 4.2, 4.4])).toBe("up");
    expect(trendOf([4.6, 4.4, 4.2, null])).toBe("down");
    expect(trendOf([4.5, 4.5, 4.5])).toBe("flat");
    expect(trendOf([null, 4.5, null])).toBe("none");
    expect(trendOf([])).toBe("none");
  });
});

describe("computeAnalytics", () => {
  it("sorts locations by volume and carries both windows", () => {
    const out = computeAnalytics({
      rows: [row("2026-10-02", { locationId: "A" }), row("2026-10-03", { locationId: "B", rating: 1, replied: false, replyHours: null }), row("2026-10-04", { locationId: "B" })],
      previousRows: [row("2026-09-02", { locationId: "A", rating: 4 })],
      names: new Map([["A", "Alpha"], ["B", "Beta"]]),
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-11-01T00:00:00Z"),
    });
    expect(out.current.count).toBe(3);
    expect(out.previous.count).toBe(1);
    expect(out.locations.map((l) => [l.name, l.count, l.needsReply])).toEqual([
      ["Beta", 2, 1],
      ["Alpha", 1, 0],
    ]);
    expect(out.period.previousTo).toBe("2026-10-01T00:00:00.000Z");
    expect(out.months).toHaveLength(1);
  });
});
