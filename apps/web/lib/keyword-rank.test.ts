import { describe, expect, it } from "vitest";
import { positionChange, positionText, shortDay } from "./keyword-rank";

describe("K4: keyword rank text", () => {
  it("shows a position or not found", () => {
    expect(positionText(3)).toBe("#3");
    expect(positionText(null)).toBe("Not found");
  });

  it("a lower number is better", () => {
    expect(positionChange(2, 5, true)).toEqual({ label: "Up 3", tone: "good" });
    expect(positionChange(7, 4, true)).toEqual({ label: "Down 3", tone: "bad" });
    expect(positionChange(4, 4, true)).toEqual({ label: "No change", tone: "neutral" });
  });

  it("entering and leaving the results", () => {
    expect(positionChange(6, null, true)).toEqual({ label: "New in results", tone: "good" });
    expect(positionChange(null, 6, true)).toEqual({ label: "Dropped out", tone: "bad" });
    expect(positionChange(null, null, true)).toEqual({ label: "No change", tone: "neutral" });
  });

  it("nothing to compare on the first reading", () => {
    expect(positionChange(2, null, false)).toBeNull();
  });

  it("formats a UTC day", () => {
    expect(shortDay("2026-10-24")).toBe("24 Oct");
  });
});
