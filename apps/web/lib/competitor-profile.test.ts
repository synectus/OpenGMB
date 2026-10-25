import { describe, expect, it } from "vitest";
import { categoryCell, daysSince } from "./competitor-profile";

const now = new Date("2026-10-24T12:00:00Z");

describe("daysSince", () => {
  it("counts whole days, never negative", () => {
    expect(daysSince("2026-10-24T01:00:00Z", now)).toBe(0);
    expect(daysSince("2026-10-20T12:00:00Z", now)).toBe(4);
    expect(daysSince("2026-11-20T12:00:00Z", now)).toBe(0);
  });
  it("is null with no usable time", () => {
    expect(daysSince(null, now)).toBeNull();
    expect(daysSince("nonsense", now)).toBeNull();
  });
});

describe("categoryCell", () => {
  it("puts the primary first and counts what was left out", () => {
    expect(categoryCell("Dentist", ["A", "B", "C"], 3)).toEqual({ shown: ["Dentist", "A", "B"], more: 1 });
    expect(categoryCell(null, ["A"])).toEqual({ shown: ["A"], more: 0 });
    expect(categoryCell(null, [])).toEqual({ shown: [], more: 0 });
  });
});
