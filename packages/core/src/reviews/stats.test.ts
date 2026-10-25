import { describe, expect, it } from "vitest";
import { changeCount, changePoints, changeRating, formatHours, percent } from "./stats";

describe("review stats formatting", () => {
  it("formats hours", () => {
    expect(formatHours(null, "en")).toBe("n/a");
    expect(formatHours(0.4, "en")).toBe("under 1 h");
    expect(formatHours(5.26, "en")).toBe("5.3 h");
    expect(formatHours(72, "en")).toBe("3 days");
    expect(formatHours(72, "es")).toBe("3 días");
    expect(formatHours(null, "es")).toBe("n/d");
  });
  it("formats rates and changes", () => {
    expect(percent(0.6)).toBe("60%");
    expect(percent(null)).toBe("n/a");
    expect(changeCount(12, 10)).toBe("+20.0%");
    expect(changeCount(5, 0)).toBe("n/a");
    expect(changeRating(3.6, 2)).toBe("+1.6");
    expect(changeRating(3.6, null)).toBe("n/a");
    expect(changePoints(0.6, 0.55)).toBe("+5 pts");
    expect(changePoints(0.5, 0.6)).toBe("-10 pts");
  });
});
