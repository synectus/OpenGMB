import { describe, expect, it } from "vitest";
import { makeTimeFormat, type ZoneInfo } from "./time-format";

const IN: ZoneInfo = { id: "w-in", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" };
const US: ZoneInfo = { id: "w-us", timeZone: "America/Chicago", dateFormat: "MM/DD/YYYY" };
const SUN_2330Z = "2026-10-18T23:30:00Z";

describe("makeTimeFormat", () => {
  it("one client: its zone and format, no label", () => {
    const tf = makeTimeFormat({ zones: [IN, US], workspaceId: "w-in" });
    expect(tf.dateTime(SUN_2330Z)).toBe("19/10/2026 05:00");
    expect(tf.time(SUN_2330Z)).toBe("05:00");
    expect(tf.dayKey(SUN_2330Z)).toBe("2026-10-19");
    expect(tf.mixed).toBe(false);
  });
  it("All clients with one shared zone: no label", () => {
    const tf = makeTimeFormat({ zones: [IN, { ...IN, id: "w2" }], workspaceId: null });
    expect(tf.dateTime(SUN_2330Z)).toBe("19/10/2026 05:00");
    expect(tf.mixed).toBe(false);
  });
  it("All clients with different zones: each row in its client's zone, with a label", () => {
    const tf = makeTimeFormat({ zones: [IN, US], workspaceId: null });
    expect(tf.mixed).toBe(true);
    expect(tf.dateTime(SUN_2330Z, "w-in")).toBe("19/10/2026 05:00 IST");
    expect(tf.dateTime(SUN_2330Z, "w-us")).toBe("10/18/2026 18:30 CDT");
    expect(tf.time(SUN_2330Z, "w-in")).toBe("05:00 IST");
  });
  it("a row with no client falls back to UTC, labelled", () => {
    const tf = makeTimeFormat({ zones: [IN, US], workspaceId: null });
    expect(tf.dateTime(SUN_2330Z)).toBe("2026-10-18 23:30 UTC");
  });
  it("no workspaces at all: UTC", () => {
    expect(makeTimeFormat({ zones: [], workspaceId: null }).dateTime(SUN_2330Z)).toBe("2026-10-18 23:30");
  });
});
