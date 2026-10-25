import { describe, expect, it } from "vitest";
import { mergeServiceItems, NORMALISE } from "./profile/fields";

const price = { currencyCode: "USD", units: "49" };
const free = (category: string, displayName: string, extra: object = {}) => ({
  freeFormServiceItem: { category, label: { displayName } },
  ...extra,
});
const structured = { structuredServiceItem: { serviceTypeId: "job_type_id:x", description: "Long text" }, price };
const current = NORMALISE.serviceItems([
  free("categories/gcid:a", "Consult", { price }),
  free("categories/gcid:b", "Massage", { price }),
  structured,
]);

describe("mergeServiceItems", () => {
  it("appends and keeps every existing item unchanged", () => {
    const out = mergeServiceItems(current, [free("categories/gcid:a", "Whitening")]) as unknown[];
    expect(out).toHaveLength(4);
    for (const old of current as unknown[]) expect(out).toContainEqual(old);
    expect(out).toContainEqual(free("categories/gcid:a", "Whitening"));
  });

  it("skips an item with the same name and category, ignoring case and spacing", () => {
    const out = mergeServiceItems(current, [free("categories/gcid:a", " consult ")]);
    expect(out).toEqual(current);
  });

  it("keeps the same name in another category", () => {
    const out = mergeServiceItems(current, [free("categories/gcid:c", "Consult")]) as unknown[];
    expect(out).toHaveLength(4);
  });

  it("adds a repeated line once", () => {
    const add = [free("categories/gcid:a", "Whitening"), free("categories/gcid:a", "whitening")];
    expect(mergeServiceItems(current, add)).toHaveLength(4);
  });

  it("works on a location with no services", () => {
    expect(mergeServiceItems(null, [free("categories/gcid:a", "Whitening")])).toHaveLength(1);
  });
});
