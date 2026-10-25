// Pure logic for the food menu editor (/locations/[id]/profile). Client-safe: types only from core.
// The editor works on Google's own JSON and only touches the fields it shows. Everything else on a
// menu, section or item (nutrition, ingredients, allergens, cuisines ...) is carried through
// untouched, because saving replaces the whole menu at Google.
import type { FoodMenuInput } from "@opengmb/core";
import { failureLabel } from "./failure-labels";
import { humanise } from "./labels";

export type Menu = FoodMenuInput;
type Section = Menu["sections"][number];
type Item = Section["items"][number];
type Attributes = Item["attributes"];
export type ItemOption = NonNullable<Item["options"]>[number];

export const DEFAULT_CURRENCY = "USD";

/** "12.50" for {units:"12", nanos:500000000}; "" when there is no price yet. */
export function priceText(price: Item["attributes"]["price"] | undefined): string {
  if (!price || price.units === undefined) return "";
  const cents = Math.round((price.nanos ?? 0) / 10_000_000);
  return `${price.units}.${String(cents).padStart(2, "0")}`;
}

/** Parses "12", "12.5" or "12.50"; null when it is not a non-negative amount with up to 2 decimals. */
export function parsePrice(text: string, currencyCode: string): Item["attributes"]["price"] | null {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m || !/^[A-Z]{3}$/.test(currencyCode)) return null;
  const cents = Number((m[2] ?? "").padEnd(2, "0") || "0");
  return { currencyCode, units: m[1]!, nanos: cents * 10_000_000 };
}

// Google's enums (FoodMenus reference, #Allergen, #DietaryRestriction, #Spiciness) with plain labels.
// The *_UNSPECIFIED values are not offered. Kept equal to FOOD_MENU_LIMITS by a test.
export const ALLERGENS = [
  ["DAIRY", "Dairy"], ["EGG", "Egg"], ["FISH", "Fish"], ["PEANUT", "Peanut"],
  ["SHELLFISH", "Shellfish"], ["SOY", "Soy"], ["TREE_NUT", "Tree nut"], ["WHEAT", "Wheat"],
] as const;
export const DIETARY = [
  ["DAIRY_FREE", "Dairy free"], ["GLUTEN_FREE", "Gluten free"], ["HALAL", "Halal"], ["KOSHER", "Kosher"],
  ["ORGANIC", "Organic"], ["VEGAN", "Vegan"], ["VEGETARIAN", "Vegetarian"],
] as const;
export const SPICINESS = [["MILD", "Mild"], ["MEDIUM", "Medium"], ["HOT", "Hot"]] as const;

type ListKey = "allergen" | "dietaryRestriction";

/** Adds or removes one value; every other attribute and any value Google sent that we don't list stays. */
export function toggleValue(attrs: Attributes, key: ListKey, value: string, on: boolean): Attributes {
  const current: string[] = attrs[key] ?? [];
  const without = current.filter((v) => v !== value);
  const list = on ? [...without, value] : without;
  const next = { ...attrs } as Record<string, unknown>;
  if (list.length > 0) next[key] = list;
  else delete next[key];
  return next as Attributes;
}

/** "" clears the spiciness. */
export function withSpiciness(attrs: Attributes, value: string): Attributes {
  const next = { ...attrs } as Record<string, unknown>;
  if (value) next.spiciness = value;
  else delete next.spiciness;
  return next as Attributes;
}
/** Google's "unspecified" reads as not set. */
export const spicinessOf = (attrs: Attributes): string =>
  attrs.spiciness && attrs.spiciness !== "SPICINESS_UNSPECIFIED" ? attrs.spiciness : "";

export const newOption = (currencyCode = DEFAULT_CURRENCY): ItemOption => ({
  labels: [{ displayName: "" }],
  attributes: { price: { currencyCode, units: "0", nanos: 0 } },
});

const named = (displayName: string) => [{ displayName }];
export const newItem = (currencyCode = DEFAULT_CURRENCY): Item => ({
  labels: named(""),
  attributes: { price: { currencyCode, units: "0", nanos: 0 } },
});
export const newSection = (currencyCode?: string): Section => ({
  labels: named(""),
  items: [newItem(currencyCode)],
});
export const newMenu = (currencyCode?: string): Menu => ({
  labels: named("Menu"),
  sections: [newSection(currencyCode)],
});

/** The first price's currency, so a new item matches the menu it joins. */
export function currencyOf(menus: Menu[]): string {
  for (const m of menus)
    for (const s of m.sections)
      for (const i of s.items) return i.attributes.price.currencyCode;
  return DEFAULT_CURRENCY;
}

/** Sets the first label's displayName and keeps its description and language. */
export function withName<T extends { labels: Menu["labels"] }>(x: T, displayName: string): T {
  const [first, ...rest] = x.labels;
  return { ...x, labels: [{ ...first, displayName }, ...rest] };
}
export const nameOf = (x: { labels: Menu["labels"] }) => x.labels[0]?.displayName ?? "";
export function withDescription<T extends { labels: Menu["labels"] }>(x: T, description: string): T {
  const [first, ...rest] = x.labels;
  const next = { ...first! };
  if (description) next.description = description;
  else delete next.description;
  return { ...x, labels: [next, ...rest] };
}

export const replaceAt = <T,>(list: T[], index: number, next: T): T[] =>
  list.map((x, i) => (i === index ? next : x));
export const removeAt = <T,>(list: T[], index: number): T[] => list.filter((_, i) => i !== index);

/** What stops a save: the first problem as a plain sentence, or null. */
export function menuProblem(menus: Menu[]): string | null {
  for (const m of menus) {
    if (!nameOf(m).trim()) return "Give every menu a name.";
    if (m.sections.length === 0) return `Add a section to ${nameOf(m)}.`;
    for (const s of m.sections) {
      if (!nameOf(s).trim()) return "Give every section a name.";
      if (s.items.length === 0) return `Add an item to ${nameOf(s)}, or remove the section.`;
      for (const i of s.items) {
        if (!nameOf(i).trim()) return "Give every item a name.";
        if ((i.options ?? []).some((o) => !nameOf(o).trim())) return `Give every option of ${nameOf(i)} a name.`;
        if (i.labels.some((l) => l.displayName.length > 140)) return "Names can be at most 140 characters.";
        if (i.labels.some((l) => (l.description ?? "").length > 1000)) return "Descriptions can be at most 1000 characters.";
      }
    }
  }
  return null;
}

export const foodMenuOpText = "Saving the menu: waiting for Google";
export function foodMenuFailure(error: string | null): string {
  return error === "google_writes_disabled"
    ? `${failureLabel(error)}.`
    : `Google did not accept it${error ? ` (${humanise(error).toLowerCase()})` : ""}`;
}
