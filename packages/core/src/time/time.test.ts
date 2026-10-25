import { describe, expect, it } from "vitest";
import {
  dayKey,
  formatDate,
  formatDateTime,
  formatTime,
  isValidTimeZone,
  localParts,
  startOfZonedDay,
  timeZoneList,
  utcToWall,
  zoneForAddress,
  zoneLabel,
  zonedWallToUtc,
} from "./index";

const IST = { timeZone: "Asia/Kolkata", dateFormat: "YYYY-MM-DD" } as const;

describe("zones", () => {
  it("validates", () => {
    for (const z of ["Asia/Kolkata", "UTC", "America/Chicago", "Australia/Sydney"]) expect(isValidTimeZone(z)).toBe(true);
    for (const z of ["Mars/Base", "", "ist"]) expect(isValidTimeZone(z)).toBe(false);
    expect(timeZoneList()).toContain("Asia/Kolkata");
    expect(timeZoneList()).not.toContain("Asia/Calcutta");
  });
  it("derives a zone from an address", () => {
    expect(zoneForAddress("IN", "Gujarat")).toBe("Asia/Kolkata");
    expect(zoneForAddress("AU", "NSW")).toBe("Australia/Sydney");
    expect(zoneForAddress("AU", "WA")).toBe("Australia/Perth");
    expect(zoneForAddress("AU")).toBe("Australia/Sydney");
    expect(zoneForAddress("US", "TX")).toBe("America/Chicago");
    expect(zoneForAddress("US", "CA")).toBe("America/Los_Angeles");
    expect(zoneForAddress("US", "NY")).toBe("America/New_York");
    expect(zoneForAddress("US", "??")).toBe("America/Chicago");
    expect(zoneForAddress("gb")).toBe("Europe/London");
    expect(zoneForAddress("FR")).toBeNull();
    expect(zoneForAddress(null)).toBeNull();
  });
});

describe("format", () => {
  it("Sunday 23:30 UTC is Monday 05:00 in Kolkata", () => {
    const at = "2026-10-18T23:30:00Z"; // a Sunday
    expect(new Date(at).getUTCDay()).toBe(0);
    expect(localParts(at, "Asia/Kolkata").weekday).toBe(1);
    expect(dayKey(at, "Asia/Kolkata")).toBe("2026-10-19");
    expect(formatTime(at, "Asia/Kolkata")).toBe("05:00");
    expect(formatDateTime(at, IST)).toBe("2026-10-19 05:00");
    expect(formatDateTime(at, { ...IST, dateFormat: "DD/MM/YYYY" }, true)).toBe("19/10/2026 05:00 IST");
    expect(formatDate(at, { ...IST, dateFormat: "MM/DD/YYYY" })).toBe("10/19/2026");
  });
  it("labels", () => {
    expect(zoneLabel("Asia/Kolkata")).toBe("IST");
    expect(zoneLabel("UTC")).toBe("UTC");
    expect(zoneLabel("America/Chicago", "2026-07-01T12:00:00Z")).toBe("CDT");
    expect(zoneLabel("America/Chicago", "2026-12-01T12:00:00Z")).toBe("CST");
  });
  it("midnight is 00:00, not 24:00", () => {
    expect(formatTime("2026-10-19T00:00:00Z", "UTC")).toBe("00:00");
  });
});

describe("wall time", () => {
  it("09:00 in Kolkata is 03:30 UTC", () => {
    expect(zonedWallToUtc("2026-10-19T09:00", "Asia/Kolkata")!.toISOString()).toBe("2026-10-19T03:30:00.000Z");
    expect(utcToWall("2026-10-19T03:30:00Z", "Asia/Kolkata")).toBe("2026-10-19T09:00");
  });
  it("rejects malformed input", () => {
    expect(zonedWallToUtc("2026-10-19", "UTC")).toBeNull();
    expect(zonedWallToUtc("2026-13-19T09:00", "UTC")).toBeNull();
  });
  it("Chicago gap moves forward, overlap takes the first", () => {
    // 2026-03-08 02:30 does not exist (02:00 CST -> 03:00 CDT): 08:30Z == 03:30 CDT
    expect(zonedWallToUtc("2026-03-08T02:30", "America/Chicago")!.toISOString()).toBe("2026-03-08T08:30:00.000Z");
    // 2026-11-01 01:30 happens twice: first is CDT (-5) = 06:30Z
    expect(zonedWallToUtc("2026-11-01T01:30", "America/Chicago")!.toISOString()).toBe("2026-11-01T06:30:00.000Z");
    expect(zonedWallToUtc("2026-07-01T09:00", "America/Chicago")!.toISOString()).toBe("2026-07-01T14:00:00.000Z");
  });
  it("Sydney gap and overlap", () => {
    // 2026-10-04 02:30 does not exist (02:00 AEST -> 03:00 AEDT): 03:30 AEDT == 16:30Z on the 3rd
    expect(zonedWallToUtc("2026-10-04T02:30", "Australia/Sydney")!.toISOString()).toBe("2026-10-03T16:30:00.000Z");
    // 2026-04-05 02:30 happens twice: first is AEDT (+11) = 15:30Z on the 4th
    expect(zonedWallToUtc("2026-04-05T02:30", "Australia/Sydney")!.toISOString()).toBe("2026-04-04T15:30:00.000Z");
  });
  it("start of a zoned day", () => {
    expect(startOfZonedDay("2026-10-19", "Asia/Kolkata").toISOString()).toBe("2026-10-18T18:30:00.000Z");
  });
});
