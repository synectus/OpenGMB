import { describe, expect, it } from "vitest";
import { livePercent, matchesFilter, parseFilter, summarize } from "./citations";

describe("citations helpers", () => {
  it("summarises statuses and prints the denominator", () => {
    expect(summarize(["live", "live", "submitted", "needs_fix", "not_started", "not_started"])).toEqual({
      total: 6, live: 2, submitted: 1, needsFix: 1, notStarted: 2,
    });
    expect(summarize([])).toEqual({ total: 0, live: 0, submitted: 0, needsFix: 0, notStarted: 0 });
  });
  it("parses a filter and falls back to all", () => {
    expect(parseFilter("live")).toBe("live");
    expect(parseFilter("nope")).toBe("all");
    expect(parseFilter(undefined)).toBe("all");
  });
  it("matches a filter", () => {
    expect(matchesFilter("live", "all")).toBe(true);
    expect(matchesFilter("live", "submitted")).toBe(false);
  });
  it("computes the live share without dividing by zero", () => {
    expect(livePercent(1, 4)).toBe(25);
    expect(livePercent(0, 0)).toBe(0);
  });
});
