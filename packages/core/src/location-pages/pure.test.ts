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
