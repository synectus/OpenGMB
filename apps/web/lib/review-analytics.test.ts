import { describe, expect, it } from "vitest";
import {
  chartModel,
  headline,
  hoursPhrase,
  kpiCards,
  resolvePeriod,
  scopeLabel,
  sparkPoints,
  starBars,
  type Totals,
} from "./review-analytics";
import { makeTimeFormat } from "./time-format";

const utc = makeTimeFormat({ zones: [], workspaceId: null });
const ist = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

const T = (o: Partial<Totals>): Totals => ({
  count: 318, rated: 318, avgRating: 4.6, replied: 290, replyRate: 290 / 318, medianReplyHours: 19, needsReply: 28, ...o,
});
const NOW = new Date("2026-10-19T08:00:00Z");

describe("resolvePeriod", () => {
  it("12m is the current month plus 11 (UTC client), ending at the end of today", () => {
    const p = resolvePeriod({}, NOW, utc);
    expect(p.key).toBe("12m");
    expect(p.from.toISOString()).toBe("2025-11-01T00:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(p.label).toBe("the last 12 months");
  });
  it("an IST client's periods are IST days: at 02:00 IST on the 20th, today is the 20th", () => {
    const p = resolvePeriod({}, new Date("2026-10-19T20:30:00Z"), ist, "w");
    expect(p.from.toISOString()).toBe("2025-10-31T18:30:00.000Z"); // 1 Nov 2025, 00:00 IST
    expect(p.to.toISOString()).toBe("2026-10-20T18:30:00.000Z"); // end of 20 Oct IST
    expect(p.toDay).toBe("2026-10-20");
    const c = resolvePeriod({ period: "custom", from: "2026-01-01", to: "2026-03-31" }, NOW, ist, "w");
    expect(c.from.toISOString()).toBe("2025-12-31T18:30:00.000Z");
    expect(c.label).toBe("01/01/2026 to 31/03/2026");
  });
  it("90d", () => {
    const p = resolvePeriod({ period: "90d" }, NOW, utc);
    expect(p.to.getTime() - p.from.getTime()).toBe(90 * 86_400_000);
  });
  it("custom: `to` is inclusive", () => {
    const p = resolvePeriod({ period: "custom", from: "2026-01-01", to: "2026-03-31" }, NOW, utc);
    expect(p.key).toBe("custom");
    expect(p.to.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(p.label).toBe("2026-01-01 to 2026-03-31");
  });
  it("a bad custom range falls back to 12m with a notice", () => {
    for (const sp of [{ period: "custom" }, { period: "custom", from: "2026-03-01", to: "2026-01-01" }, { period: "custom", from: "2020-01-01", to: "2026-10-01" }, { period: "custom", from: "x", to: "y" }]) {
      const p = resolvePeriod(sp, NOW, utc);
      expect(p.key).toBe("12m");
      expect(p.notice).toMatch(/not valid/);
    }
  });
});

describe("headline", () => {
  it("canary: the board sentence", () => {
    expect(headline({ scope: "Rivermoor Pain Clinic", label: "the last 12 months", cur: T({ avgRating: 4.6, replyRate: 0.91 }), prev: T({ avgRating: 4.5 }) })).toBe(
      "Rivermoor Pain Clinic averaged 4.6★ over the last 12 months, up 0.1. You replied to 91% of reviews, usually within 19 hours.",
    );
  });
  it("down, unchanged, no earlier data, no reply time", () => {
    const base = { scope: "X", label: "the last 90 days" };
    expect(headline({ ...base, cur: T({ avgRating: 4.2 }), prev: T({ avgRating: 4.5 }) })).toContain(", down 0.3.");
    expect(headline({ ...base, cur: T({ avgRating: 4.5 }), prev: T({ avgRating: 4.5 }) })).toContain(", unchanged.");
    expect(headline({ ...base, cur: T({ avgRating: 4.5 }), prev: T({ count: 0, avgRating: null }) })).toMatch(/^X averaged 4\.5★ over the last 90 days\. /);
    expect(headline({ ...base, cur: T({ medianReplyHours: null }), prev: T({}) })).not.toContain("usually within");
  });
  it("no reviews says so", () => {
    expect(headline({ scope: "X", label: "the last 12 months", cur: T({ count: 0, avgRating: null, replyRate: null }), prev: T({}) })).toBe(
      "No Google reviews came in for X during the last 12 months.",
    );
  });
});

describe("hoursPhrase", () => {
  it("under an hour, hours, days", () => {
    expect(hoursPhrase(0.4)).toBe("under an hour");
    expect(hoursPhrase(1)).toBe("1 hour");
    expect(hoursPhrase(19.2)).toBe("19 hours");
    expect(hoursPhrase(96)).toBe("4 days");
  });
});

describe("kpiCards", () => {
  it("canary: the four board tiles", () => {
    const k = kpiCards(T({ avgRating: 4.6, count: 318, replyRate: 0.91, replied: 290, medianReplyHours: 19 }), T({ avgRating: 4.5, count: 256, replyRate: 0.85, medianReplyHours: 26 }));
    expect(k.map((x) => [x.label, x.value, x.delta, x.tone])).toEqual([
      ["Average rating", "4.6★", "▲ 0.1", "good"],
      ["New reviews", "318", "▲ 24%", "good"],
      ["Reply rate", "91%", "▲ 6 pts", "good"],
      ["Median time to reply", "19 h", "▼ 7 h", "good"],
    ]);
    expect(k[1]!.note).toBe("vs 256");
    expect(k[2]!.note).toBe("290 of 318 have a reply");
    expect(k[3]!.note).toBe("faster than before");
  });
  it("worse numbers are bad; a longer reply time is bad; no earlier window has no delta", () => {
    const k = kpiCards(T({ avgRating: 4.0, count: 10, replyRate: 0.5, medianReplyHours: 40 }), T({ avgRating: 4.5, count: 20, replyRate: 0.9, medianReplyHours: 20 }));
    expect(k.map((x) => x.tone)).toEqual(["bad", "bad", "bad", "bad"]);
    const none = kpiCards(T({}), T({ count: 0, rated: 0, avgRating: null, replyRate: null, medianReplyHours: null, replied: 0, needsReply: 0 }));
    expect(none.map((x) => x.delta)).toEqual([null, null, null, null]);
  });
});

describe("chartModel", () => {
  const months = Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, "0")}`, total: 10 + i, low: 2, avg: i === 3 ? null : 4.5 }));
  it("12 bars inside the plot, low part under the high part, axis rounded up", () => {
    const c = chartModel(months);
    expect(c.bars).toHaveLength(12);
    expect(c.axisMax).toBe(30);
    for (const b of c.bars) {
      expect(b.x).toBeGreaterThanOrEqual(40);
      expect(b.x + b.width).toBeLessThanOrEqual(710);
      expect(b.hHigh + b.hLow).toBe(200 - b.yTop);
    }
    expect(c.bars[0]!.label).toBe("Jan");
  });
  it("the rating line skips months without ratings and clamps to the 4 to 5 scale", () => {
    const c = chartModel([{ month: "2026-01", total: 1, low: 0, avg: 3.2 }, { month: "2026-02", total: 1, low: 0, avg: null }, { month: "2026-03", total: 1, low: 0, avg: 5 }]);
    expect(c.line.split(" ")).toHaveLength(2);
    expect(c.line.split(" ")[0]!.endsWith(",200")).toBe(true);
    expect(c.line.split(" ")[1]!.endsWith(",40")).toBe(true);
  });
  it("no data is not NaN", () => {
    const c = chartModel([{ month: "2026-01", total: 0, low: 0, avg: null }]);
    expect(c.axisMax).toBe(10);
    expect(c.bars[0]!.hHigh).toBe(0);
    expect(c.line).toBe("");
  });
});

describe("starBars, sparkPoints, scopeLabel", () => {
  it("percentages of all reviews", () => {
    const s = starBars([{ star: 5, count: 3 }, { star: 4, count: 1 }, { star: 3, count: 0 }, { star: 2, count: 0 }, { star: 1, count: 0 }]);
    expect(s[0]).toMatchObject({ star: "5★", n: 3, pct: 75 });
    expect(starBars([{ star: 5, count: 0 }])[0]!.pct).toBe(0);
  });
  it("sparkline: higher rating is higher on screen; flat is the middle; one point is empty", () => {
    expect(sparkPoints([4.0, 5.0])).toBe("0,18 80,4");
    expect(sparkPoints([4.5, 4.5])).toBe("0,11 80,11");
    expect(sparkPoints([null, 4.5, null])).toBe("");
  });
  it("scope label: location, workspace, the only workspace, or a generic phrase", () => {
    const workspaces = [{ id: "w1", name: "Rivermoor Pain Clinic" }];
    const locations = [{ id: "l1", name: "Rivermoor Main St", workspaceId: "w1" }];
    expect(scopeLabel({ loc: "l1", workspaces, locations })).toBe("Rivermoor Main St");
    expect(scopeLabel({ ws: "w1", workspaces, locations })).toBe("Rivermoor Pain Clinic");
    expect(scopeLabel({ workspaces, locations })).toBe("Rivermoor Pain Clinic");
    expect(scopeLabel({ workspaces: [...workspaces, { id: "w2", name: "B" }], locations })).toBe("Your locations");
  });
});
