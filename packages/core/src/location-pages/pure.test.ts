import { describe, expect, it } from "vitest";
import { categoryLabel, hoursRows, httpsOnly, localBusinessJsonLd, mapsUrl, safeJsonLd, type PageData } from "./pure";

const base: PageData = {
  slug: "x", name: "Acme", description: "d", categories: [], address: "1 Main St", mapUrl: "", phone: "+1 555", website: "https://acme.test/",
  hours: [], services: [], rating: 4.5, reviewCount: 2, reviewNote: null, reviews: [], posts: [], photos: [], brand: { agencyName: "A", logoUrl: null, primaryColor: null },
};

describe("location page pure helpers", () => {
  it("hoursRows lists the week, closed days and split days", () => {
    const rows = hoursRows({ periods: [
      { openDay: "MONDAY", openTime: { hours: 9 }, closeDay: "MONDAY", closeTime: { hours: 12 } },
      { openDay: "MONDAY", openTime: { hours: 13 }, closeDay: "MONDAY", closeTime: { hours: 17, minutes: 30 } },
    ] });
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({ day: "Monday", text: "9:00 AM to 12:00 PM, 1:00 PM to 5:30 PM" });
    expect(rows[1]).toEqual({ day: "Tuesday", text: "Closed" });
    expect(hoursRows(null)).toEqual([]);
  });
  it("labels categories and builds a map link", () => {
    expect(categoryLabel("categories/gcid:physical_therapist")).toBe("Physical therapist");
    expect(mapsUrl("A & B", "1 Main")).toBe("https://www.google.com/maps/search/?api=1&query=A%20%26%20B%201%20Main");
  });
  it("httpsOnly refuses other schemes and credentials", () => {
    expect(httpsOnly("javascript:alert(1)")).toBeNull();
    expect(httpsOnly("http://a.test")).toBeNull();
    expect(httpsOnly("https://u:p@a.test")).toBeNull();
    expect(httpsOnly("https://a.test/x")).toBe("https://a.test/x");
  });
  it("JSON-LD is a LocalBusiness and cannot close the script tag", () => {
    const ld = localBusinessJsonLd({ ...base, name: "</script><b>" }, "https://app.test/l/x", { periods: [{ openDay: "MONDAY", openTime: { hours: 9 }, closeTime: { hours: 17 } }] });
    expect(ld["@type"]).toBe("LocalBusiness");
    expect(ld.aggregateRating).toMatchObject({ ratingValue: 4.5, reviewCount: 2 });
    expect(ld.openingHoursSpecification).toEqual([{ "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/Monday", opens: "09:00", closes: "17:00" }]);
    expect(safeJsonLd(ld)).not.toContain("</script>");
    expect(JSON.parse(safeJsonLd(ld)).name).toBe("</script><b>");
  });
});

const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
const text = (r: unknown) => hoursRows(r).map((x) => x.text);

describe("hoursRows across midnight and omitted fields", () => {
  const nightly = { periods: DAYS.flatMap((d) => [
    { openDay: d, openTime: { hours: 23 }, closeDay: d, closeTime: { hours: 24 } },
    { openDay: d, closeDay: d, closeTime: { hours: 4 } },
  ]) };
  it("joins the 23:00 to 24:00 and 00:00 to 04:00 halves into one window on every day", () => {
    expect(text(nightly)).toEqual(Array(7).fill("11:00 PM to 4:00 AM"));
  });
  it("wraps Sunday into Monday", () => {
    const r = { periods: [
      { openDay: "SUNDAY", openTime: { hours: 22 }, closeDay: "SUNDAY", closeTime: { hours: 24 } },
      { openDay: "MONDAY", closeDay: "MONDAY", closeTime: { hours: 2, minutes: 30 } },
    ] };
    expect(text(r)).toEqual(["Closed", "Closed", "Closed", "Closed", "Closed", "Closed", "10:00 PM to 2:30 AM"]);
  });
  it("reads a true 24 hour day, and every day, as Open 24 hours", () => {
    const all = { periods: DAYS.map((d) => ({ openDay: d, closeDay: d, closeTime: { hours: 24 } })) };
    expect(text(all)).toEqual(Array(7).fill("Open 24 hours"));
    const nextDay = { periods: DAYS.map((d, i) => ({ openDay: d, closeDay: DAYS[(i + 1) % 7], closeTime: {} })) };
    expect(text(nextDay)).toEqual(Array(7).fill("Open 24 hours"));
    expect(text({ periods: [{ openDay: "MONDAY", openTime: {}, closeDay: "MONDAY", closeTime: {} }] })[0]).toBe("Open 24 hours");
  });
  it("reads a period Google already encodes as crossing midnight on its opening day", () => {
    const r = { periods: [{ openDay: "FRIDAY", openTime: { hours: 18 }, closeDay: "SATURDAY", closeTime: { hours: 3 } }] };
    expect(hoursRows(r)[4]).toEqual({ day: "Friday", text: "6:00 PM to 3:00 AM" });
    expect(hoursRows(r)[5]).toEqual({ day: "Saturday", text: "Closed" });
  });
  it("splits a period longer than a day into per-day pieces", () => {
    const r = { periods: [{ openDay: "FRIDAY", openTime: { hours: 18 }, closeDay: "SUNDAY", closeTime: { hours: 3 } }] };
    expect(text(r)).toEqual(["Closed", "Closed", "Closed", "Closed", "6:00 PM to 12:00 AM", "Open 24 hours", "12:00 AM to 3:00 AM"]);
    const spec = (localBusinessJsonLd(base, "https://app.test/l/x", r).openingHoursSpecification as { dayOfWeek: string; opens: string; closes: string }[]).map((x) => `${x.dayOfWeek.replace("https://schema.org/", "")} ${x.opens}-${x.closes}`);
    expect(spec).toEqual(["Friday 18:00-24:00", "Saturday 00:00-24:00", "Sunday 00:00-03:00"]);
    const mon = { periods: [{ openDay: "MONDAY", openTime: { hours: 10 }, closeDay: "TUESDAY", closeTime: { hours: 10 } }] };
    expect(text(mon).slice(0, 2)).toEqual(["10:00 AM to 12:00 AM", "12:00 AM to 10:00 AM"]);
    const monSpec = (localBusinessJsonLd(base, "https://app.test/l/x", mon).openingHoursSpecification as { dayOfWeek: string; opens: string; closes: string }[]).map((x) => `${x.dayOfWeek.replace("https://schema.org/", "")} ${x.opens}-${x.closes}`);
    expect(monSpec).toEqual(["Monday 10:00-24:00", "Tuesday 00:00-10:00"]);
  });
  it("treats omitted hours and minutes as zero", () => {
    const r = { periods: [{ openDay: "MONDAY", closeDay: "MONDAY", closeTime: { hours: 12 } }, { openDay: "TUESDAY", openTime: { minutes: 30 }, closeDay: "TUESDAY", closeTime: { hours: 1 } }] };
    expect(text(r).slice(0, 2)).toEqual(["12:00 AM to 12:00 PM", "12:30 AM to 1:00 AM"]);
  });
  it("keeps two separate same-day windows (a lunch break) as two, sorted by opening time", () => {
    const r = { periods: [
      { openDay: "MONDAY", openTime: { hours: 13 }, closeDay: "MONDAY", closeTime: { hours: 17 } },
      { openDay: "MONDAY", openTime: { hours: 9 }, closeDay: "MONDAY", closeTime: { hours: 12 } },
    ] };
    expect(text(r)[0]).toBe("9:00 AM to 12:00 PM, 1:00 PM to 5:00 PM");
  });
  it("never renders a blank row", () => {
    expect(text({ periods: [{ openDay: "MONDAY", closeDay: "MONDAY" }] }).every((t) => t.length > 0)).toBe(true);
    expect(text({ periods: [{ openDay: "MONDAY", openTime: { hours: 9 }, closeDay: "MONDAY", closeTime: { hours: 17 } }] })[3]).toBe("Closed");
  });
  it("JSON-LD describes the same joined window", () => {
    const ld = localBusinessJsonLd(base, "https://app.test/l/x", nightly);
    const spec = ld.openingHoursSpecification as { dayOfWeek: string; opens: string; closes: string }[];
    expect(spec).toHaveLength(7);
    expect(spec[0]).toMatchObject({ dayOfWeek: "https://schema.org/Monday", opens: "23:00", closes: "04:00" });
    expect(spec.every((s) => s.opens === "23:00" && s.closes === "04:00")).toBe(true);
  });
});
