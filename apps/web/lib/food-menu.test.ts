import { FOOD_MENU_LIMITS } from "@opengmb/core";
import { describe, expect, it } from "vitest";
import {
  ALLERGENS,
  DIETARY,
  SPICINESS,
  currencyOf,
  menuProblem,
  newOption,
  spicinessOf,
  toggleValue,
  withSpiciness,
  newMenu,
  parsePrice,
  priceText,
  withDescription,
  withName,
  type Menu,
} from "./food-menu";

const item = (extra = {}) => ({
  labels: [{ displayName: "Soup" }],
  attributes: { price: { currencyCode: "EUR", units: "4", nanos: 500_000_000 } },
  ...extra,
});
type Item = Menu["sections"][number]["items"][number];
const menu = (): Menu => ({
  labels: [{ displayName: "Lunch" }],
  sections: [{ labels: [{ displayName: "Starters" }], items: [item()] }],
});

describe("food menu logic", () => {
  it("prices round trip between text and Google's units+nanos", () => {
    expect(parsePrice("12.5", "USD")).toEqual({ currencyCode: "USD", units: "12", nanos: 500_000_000 });
    expect(parsePrice("12", "USD")).toEqual({ currencyCode: "USD", units: "12", nanos: 0 });
    expect(priceText({ currencyCode: "USD", units: "12", nanos: 500_000_000 })).toBe("12.50");
    expect(priceText({ currencyCode: "USD", nanos: 0 })).toBe("");
    for (const bad of ["", "abc", "-1", "1.234", "1,5"]) expect(parsePrice(bad, "USD")).toBeNull();
    expect(parsePrice("1", "usd")).toBeNull();
  });

  it("renaming keeps unknown fields and the label's language; description can be cleared", () => {
    const m = { ...menu(), cuisines: ["ITALIAN"], labels: [{ displayName: "Lunch", languageCode: "en" }] };
    const r = withName(m, "Dinner");
    expect(r).toMatchObject({ cuisines: ["ITALIAN"], labels: [{ displayName: "Dinner", languageCode: "en" }] });
    const d = withDescription(r, "Served 5-9");
    expect(d.labels[0]).toMatchObject({ description: "Served 5-9", languageCode: "en" });
    expect(withDescription(d, "").labels[0]).not.toHaveProperty("description");
  });

  it("menuProblem flags blanks and empty groups, null when fine", () => {
    expect(menuProblem([menu()])).toBeNull();
    expect(menuProblem([newMenu()])).toBe("Give every section a name.");
    const noItems = menu();
    noItems.sections[0]!.items = [];
    expect(menuProblem([noItems])).toMatch(/Add an item/);
    expect(menuProblem([{ ...menu(), labels: [{ displayName: " " }] }])).toBe("Give every menu a name.");
  });

  it("currencyOf follows the existing prices", () => {
    expect(currencyOf([menu()])).toBe("EUR");
    expect(currencyOf([])).toBe("USD");
  });

  it("the offered tags are exactly Google's enums, minus UNSPECIFIED", () => {
    const no = (l: readonly string[]) => l.filter((v) => !v.endsWith("_UNSPECIFIED"));
    expect(ALLERGENS.map((a) => a[0])).toEqual(no(FOOD_MENU_LIMITS.allergens));
    expect(DIETARY.map((a) => a[0])).toEqual(no(FOOD_MENU_LIMITS.dietary));
    expect(SPICINESS.map((a) => a[0])).toEqual(no(FOOD_MENU_LIMITS.spiciness));
  });

  it("toggling a tag keeps every other attribute and unlisted values; emptying removes the key", () => {
    const attrs: Item["attributes"] = {
      price: { currencyCode: "USD", units: "1", nanos: 0 },
      allergen: ["ALLERGEN_UNSPECIFIED"],
      servesNumPeople: 2,
      mediaKeys: ["k1"],
      nutritionFacts: { calories: { lowerAmount: 5, unit: "CALORIE" } },
    };
    const on = toggleValue(attrs, "allergen", "SOY", true);
    expect(on).toEqual({ ...attrs, allergen: ["ALLERGEN_UNSPECIFIED", "SOY"] });
    expect(toggleValue(on, "allergen", "SOY", true).allergen).toEqual(["ALLERGEN_UNSPECIFIED", "SOY"]);
    const off = toggleValue(toggleValue(on, "allergen", "SOY", false), "allergen", "ALLERGEN_UNSPECIFIED", false);
    expect(off).not.toHaveProperty("allergen");
    expect(off).toMatchObject({ servesNumPeople: 2, mediaKeys: ["k1"] });
    expect(toggleValue(attrs, "dietaryRestriction", "VEGAN", true).dietaryRestriction).toEqual(["VEGAN"]);
  });

  it("spiciness sets, clears, and reads UNSPECIFIED as not set", () => {
    const attrs = { price: { currencyCode: "USD", units: "1", nanos: 0 } };
    const hot = withSpiciness(attrs, "HOT");
    expect(hot.spiciness).toBe("HOT");
    expect(spicinessOf(hot)).toBe("HOT");
    expect(withSpiciness(hot, "")).not.toHaveProperty("spiciness");
    expect(spicinessOf({ ...attrs, spiciness: "SPICINESS_UNSPECIFIED" })).toBe("");
  });

  it("an option needs a name; a named option passes", () => {
    const m = menu();
    m.sections[0]!.items[0]!.options = [newOption("EUR")];
    expect(menuProblem([m])).toBe("Give every option of Soup a name.");
    m.sections[0]!.items[0]!.options = [{ ...newOption("EUR"), labels: [{ displayName: "Large" }] }];
    expect(menuProblem([m])).toBeNull();
  });
});
