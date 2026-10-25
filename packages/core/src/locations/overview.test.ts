import { describe, expect, it } from "vitest";
import { clip, hoursOn, isOpenNow, zonedDay } from "./overview";

const p = (openDay: string, oh: number, ch: number, om?: number) => ({
  openDay,
  openTime: { hours: oh, ...(om ? { minutes: om } : {}) },
  closeDay: openDay,
  closeTime: { hours: ch },
});

describe("zonedDay", () => {
  it("Sunday 23:30 UTC is already Monday in Asia/Kolkata", () => {
    const at = new Date("2026-10-18T23:30:00Z");
    expect(zonedDay(at, "UTC")).toBe("SUNDAY");
    expect(zonedDay(at, "Asia/Kolkata")).toBe("MONDAY");
    expect(zonedDay(at, "America/Chicago")).toBe("SUNDAY");
    expect(zonedDay(new Date("2026-10-19T00:10:00Z"), "UTC")).toBe("MONDAY");
  });
  it("a location open Monday and closed Sunday: 'Closed today' on Monday 05:00 IST is wrong in UTC only", () => {
    const hours = [p("MONDAY", 9, 17)];
    const at = new Date("2026-10-18T23:30:00Z"); // Sunday in UTC, Monday 05:00 in Kolkata
    expect(hoursOn(hours, zonedDay(at, "UTC"))).toBeNull();
    expect(hoursOn(hours, zonedDay(at, "Asia/Kolkata"))).toBe("09:00 to 17:00");
    // not open yet at 05:00 local, open at 10:30 local (05:00Z)
    expect(isOpenNow(hours, at, "Asia/Kolkata")).toBe(false);
    expect(isOpenNow(hours, new Date("2026-10-19T05:00:00Z"), "Asia/Kolkata")).toBe(true);
    expect(isOpenNow(hours, new Date("2026-10-19T05:00:00Z"), "UTC")).toBe(false); // 05:00 UTC Monday
  });
});

describe("isOpenNow", () => {
  const at = (iso: string, tz = "UTC") => (h: Parameters<typeof isOpenNow>[0]) => isOpenNow(h, new Date(iso), tz);
  it("null without hours", () => expect(isOpenNow([], new Date(), "UTC")).toBeNull());
  it("closes exclusively", () => {
    const h = [p("MONDAY", 9, 17)];
    expect(at("2026-10-19T16:59:00Z")(h)).toBe(true);
    expect(at("2026-10-19T17:00:00Z")(h)).toBe(false);
  });
  it("periods that cross midnight", () => {
    const h = [{ openDay: "FRIDAY", openTime: { hours: 18 }, closeDay: "SATURDAY", closeTime: { hours: 2 } }];
    expect(at("2026-10-24T01:00:00Z")(h)).toBe(true); // Saturday 01:00
    expect(at("2026-10-24T03:00:00Z")(h)).toBe(false);
    expect(at("2026-10-23T19:00:00Z")(h)).toBe(true); // Friday 19:00
  });
  it("wraps Saturday night into Sunday", () => {
    const h = [{ openDay: "SATURDAY", openTime: { hours: 20 }, closeDay: "SUNDAY", closeTime: { hours: 3 } }];
    expect(at("2026-10-18T02:00:00Z")(h)).toBe(true); // Sunday 02:00
  });
  it("24 hours", () => {
    const h = [{ openDay: "MONDAY", openTime: {}, closeDay: "MONDAY", closeTime: { hours: 24 } }];
    expect(at("2026-10-19T23:59:00Z")(h)).toBe(true);
    expect(at("2026-10-20T00:00:00Z")(h)).toBe(false);
  });
});

describe("hoursOn", () => {
  it("formats every period of the day, sorted, zero-padded", () => {
    expect(hoursOn([p("MONDAY", 14, 18), p("MONDAY", 8, 12, 30)], "MONDAY")).toBe("08:30 to 12:00, 14:00 to 18:00");
  });
  it("reads omitted zero values as 00 (proto3 JSON) and 24 as a closing time", () => {
    expect(
      hoursOn([{ openDay: "TUESDAY", openTime: {}, closeDay: "TUESDAY", closeTime: { hours: 24 } }], "TUESDAY"),
    ).toBe("00:00 to 24:00");
  });
  it("is null on a day with no period (closed)", () => {
    expect(hoursOn([p("MONDAY", 9, 17)], "SUNDAY")).toBeNull();
  });
});

describe("clip", () => {
  it("flattens whitespace and clips with an ellipsis", () => {
    expect(clip("Weekly  back-care\ntip", 60)).toBe("Weekly back-care tip");
    expect(clip("abcdefghij", 5)).toBe("abcd…");
  });
});
