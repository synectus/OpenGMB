import { describe, expect, it } from "vitest";
import { describeChange } from "./describe-change";

const place = (n: string, id = n.toLowerCase()) => ({ placeName: n, placeId: id });
const area = (businessType: string, names: string[]) => ({
  businessType,
  places: { placeInfos: names.map((n) => place(n)) },
});

describe("describeChange: serviceArea", () => {
  const long = Array.from({ length: 11 }, (_, i) => `Town ${i}, Mehsana, Gujarat, India`);
  it("shows only the address flag when only businessType changed (the 2026-10-24 case)", () => {
    expect(
      describeChange("serviceArea", area("CUSTOMER_LOCATION_ONLY", long), area("CUSTOMER_AND_BUSINESS_LOCATION", long)),
    ).toEqual([
      { type: "addressShown", before: false, after: true },
      { type: "placesUnchanged", count: 11 },
    ]);
  });
  it("lists places added and removed by name", () => {
    expect(
      describeChange(
        "serviceArea",
        area("CUSTOMER_LOCATION_ONLY", ["A", "B", "C"]),
        area("CUSTOMER_LOCATION_ONLY", ["B", "C", "D", "E"]),
      ),
    ).toEqual([
      { type: "placesRemoved", names: ["A"] },
      { type: "placesAdded", names: ["D", "E"] },
    ]);
  });
  it("says unchanged when the list is equal and nothing else differs", () => {
    expect(
      describeChange("serviceArea", area("CUSTOMER_LOCATION_ONLY", ["A"]), area("CUSTOMER_AND_BUSINESS_LOCATION", ["A"])),
    ).toContainEqual({ type: "placesUnchanged", count: 1 });
  });
  it("handles a service area added from nothing", () => {
    expect(describeChange("serviceArea", null, area("CUSTOMER_LOCATION_ONLY", ["A"]))).toEqual([
      { type: "addressShown", before: null, after: false },
      { type: "placesAdded", names: ["A"] },
    ]);
  });
  it("returns nothing when equal", () => {
    expect(describeChange("serviceArea", area("CUSTOMER_LOCATION_ONLY", ["A"]), area("CUSTOMER_LOCATION_ONLY", ["A"]))).toEqual([]);
  });
});

describe("describeChange: generic", () => {
  it("lists only changed keys, however deep and however long the value", () => {
    const filler = Array.from({ length: 40 }, (_, i) => ({ day: `D${i}`, open: "09:00", close: "17:00" }));
    const b = { periods: [...filler, { day: "SUNDAY", open: "09:00", close: "17:00" }], note: "x".repeat(900) };
    const a = { periods: [...filler, { day: "SUNDAY", open: "10:00", close: "17:00" }], note: "x".repeat(900) };
    expect(describeChange("regularHours", b, a)).toEqual([
      { type: "key", path: "periods[41].open", before: "09:00", after: "10:00" },
    ]);
  });
  it("reports keys added and removed", () => {
    expect(describeChange("storefrontAddress", { locality: "A", postalCode: "1" }, { locality: "A", regionCode: "IN" })).toEqual([
      { type: "key", path: "postalCode", before: "1", after: null },
      { type: "key", path: "regionCode", before: null, after: "IN" },
    ]);
  });
  it("reports items added to and removed from a list of plain values", () => {
    expect(describeChange("phoneNumbers", { additionalPhones: ["1", "2"] }, { additionalPhones: ["2", "3"] })).toEqual([
      { type: "key", path: "additionalPhones", before: "1", after: "3" },
    ]);
  });
  it("trims long unchanged text but keeps the changed part", () => {
    const pad = "lorem ipsum ".repeat(60);
    const [line] = describeChange("x", { t: `${pad}OLD${pad}` }, { t: `${pad}NEW${pad}` });
    if (line?.type !== "key") throw new Error("expected key line");
    expect(line.before).toContain("OLD");
    expect(line.after).toContain("NEW");
    expect(line.before!.length).toBeLessThan(120);
  });
  it("turns enum words into plain words", () => {
    expect(describeChange("x", { s: "OPEN_FOR_BUSINESS" }, { s: "CLOSED_TEMPORARILY" })).toEqual([
      { type: "key", path: "s", before: "Open for business", after: "Temporarily closed" },
    ]);
  });
  it("returns nothing when equal", () => {
    expect(describeChange("x", { a: [1] }, { a: [1] })).toEqual([]);
  });
});
