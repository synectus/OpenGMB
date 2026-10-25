import { describe, expect, it } from "vitest";
import { copyNotes, copySummary, itemForRow, itemsForGroup, sendLists } from "./copy-services";
import type { ServiceGroup, ServiceRow } from "./services-manager";

const own: ServiceRow = {
  kind: "own",
  index: 0,
  name: " Teeth whitening ",
  description: "Zoom, 60 min",
  price: { currencyCode: "USD", units: "250" },
  category: "categories/gcid:dentist",
};
const google: ServiceRow = {
  kind: "google",
  id: "job_type_id:teeth_cleaning",
  name: "Teeth cleaning",
  description: "Scale and polish",
  price: { currencyCode: "USD", units: "120" },
  selected: true,
};

describe("copy items", () => {
  it("an own service copies as free-form with its category, description and price", () => {
    expect(itemForRow(own)).toEqual({
      name: "Teeth whitening",
      item: {
        freeFormServiceItem: {
          category: "categories/gcid:dentist",
          label: { displayName: "Teeth whitening", description: "Zoom, 60 min" },
        },
        price: { currencyCode: "USD", units: "250" },
      },
    });
  });
  it("a Google-list service copies as structured; an unticked one or an unnamed own one does not copy", () => {
    expect(itemForRow(google)?.item).toEqual({
      structuredServiceItem: { serviceTypeId: "job_type_id:teeth_cleaning", description: "Scale and polish" },
      price: { currencyCode: "USD", units: "120" },
    });
    expect(itemForRow({ ...google, selected: false })).toBeNull();
    expect(itemForRow({ ...own, name: "  " })).toBeNull();
  });
  it("a category copies its included services; Other copies nothing", () => {
    const g = (key: string): ServiceGroup => ({
      key,
      label: key,
      rows: [google, { ...google, id: "x", selected: false }, own],
      count: 2,
    });
    expect(itemsForGroup(g("categories/gcid:dentist")).map((c) => c.name)).toEqual(["Teeth cleaning", "Teeth whitening"]);
    expect(itemsForGroup(g("other"))).toEqual([]);
  });
});

describe("copy flags", () => {
  const names = ["Whitening", "Cleaning", "Veneers", "Braces"];
  it("names each flagged item and its reason, and counts the ones left unchanged", () => {
    const n = copyNotes(names, {
      send: [0],
      alreadyThere: [2],
      skipped: [
        { index: 1, reason: "type_not_offered" },
        { index: 3, reason: "category_not_on_location" },
      ],
    })!;
    expect(n.added).toBe(1);
    expect(n.unchanged).toMatch(/^1 already there, left as they are/);
    expect(n.flags).toEqual([
      "Cleaning: not sent, Google does not list it for this location's categories",
      "Braces: not sent, its category is not one of this location's categories",
    ]);
  });
  it("over the cap says so; nothing flagged gives no flags", () => {
    expect(copyNotes(names, { send: [], alreadyThere: [], skipped: [{ index: 0, reason: "over_cap" }] })!.flags[0]).toBe(
      "Whitening: not sent, the list would pass 300 services",
    );
    expect(copyNotes(names, { send: [0], alreadyThere: [], skipped: [] })).toEqual({ added: 1, unchanged: null, flags: [] });
    expect(copyNotes(names, null)).toBeNull();
  });
  it("summarises across targets and echoes the send lists", () => {
    expect(copySummary([{ added: 2, flags: [] }, { added: 0, flags: ["a", "b"] }])).toBe("2 services will be added, 2 not sent");
    expect(copySummary([{ added: 1, flags: [] }])).toBe("1 service will be added");
    expect(sendLists([{ locationId: "l1", serviceAdd: { send: [0, 2], alreadyThere: [], skipped: [] } }, { locationId: "l2" }])).toEqual([
      { locationId: "l1", indexes: [0, 2] },
    ]);
  });
});
