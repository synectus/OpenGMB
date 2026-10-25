import { describe, expect, it } from "vitest";
import { HOLIDAYS, upcomingHolidays } from "./holidays";

const names = (m: "us" | "au" | "in", today: string) => upcomingHolidays(m, today).map((h) => h.name);

describe("upcomingHolidays", () => {
  it("is filtered to the client's market", () => {
    const us = names("us", "2026-10-21");
    const au = names("au", "2026-10-21");
    const inn = names("in", "2026-10-21");
    expect(us).toContain("Thanksgiving");
    expect(us).not.toContain("Melbourne Cup Day");
    expect(au).toContain("Melbourne Cup Day");
    expect(au).not.toContain("Thanksgiving");
    expect(inn).toContain("Children's Day");
    expect(inn).not.toContain("Halloween");
  });

  it("covers the next 60 days only, both ends inclusive of day 60 and exclusive of day 61", () => {
    // 2026-10-21 + 60 days = 2026-12-20; + 61 = 2026-12-21.
    expect(names("us", "2026-10-25")).toContain("Christmas Eve"); // day 60 (2026-12-24)
    expect(names("us", "2026-10-24")).not.toContain("Christmas Eve"); // day 61
    const list = upcomingHolidays("us", "2026-10-21");
    expect(list.every((h) => h.date >= "2026-10-21" && h.date <= "2026-12-20")).toBe(true);
    expect(list.map((h) => h.name)).toEqual(["Halloween", "Veterans Day", "Thanksgiving", "Black Friday", "Small Business Saturday"]);
  });

  it("includes today and drops yesterday", () => {
    expect(names("us", "2026-10-31")).toContain("Halloween");
    expect(names("us", "2026-11-01")).not.toContain("Halloween");
  });

  it("every entry is a real calendar date, sorted per market", () => {
    for (const [m, list] of Object.entries(HOLIDAYS)) {
      expect(list.length, m).toBeGreaterThan(0);
      for (const h of list) expect(new Date(`${h.date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(h.date);
      expect(list.map((h) => h.date)).toEqual(list.map((h) => h.date).sort());
    }
  });
});
