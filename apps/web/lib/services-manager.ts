// Pure logic for the Services manager on /locations/[id]/profile: grouping by category, search, and
// price conversion. Client-safe.
import type { CategoryMeta } from "./profile-pickers";
import { categoryLabel, humanise } from "./labels";
import { structuredItems, type Money, type OwnService, type ServiceItem, type StructuredDetail } from "./profile-editor";

export { moneyToAmount, priceText } from "./profile-editor";

export type { Money } from "./profile-editor";

// ------------------------------------------------------------------ price

/**
 * Typed amount and currency to google.type.Money. Decimal text is split on the point, never
 * multiplied, so 1499.50 is units "1499" and nanos 500000000 with no float rounding. Google omits a
 * zero units or nanos, so this does too. An empty amount means no price.
 */
export function amountToMoney(amount: string, currency: string): { money: Money | null } | { error: string } {
  const text = amount.trim();
  if (!text) return { money: null };
  const m = /^(\d{1,15})(?:\.(\d{1,9}))?$/.exec(text);
  if (!m) return { error: "Enter a price such as 1499.50 (up to 9 decimals, no commas)." };
  if (!/^[A-Z]{3}$/.test(currency)) return { error: "Currency is a 3-letter code such as INR or USD." };
  const units = (m[1] ?? "0").replace(/^0+(?=\d)/, "");
  const nanos = Number((m[2] ?? "").padEnd(9, "0"));
  return {
    money: {
      currencyCode: currency,
      ...(units !== "0" ? { units } : {}),
      ...(nanos ? { nanos } : {}),
    },
  };
}

const REGION_CURRENCY: Record<string, string> = { IN: "INR", AU: "AUD", GB: "GBP", CA: "CAD", NZ: "NZD" };
/** The currency a new price starts in: one already used on this location, else by region, else USD. */
export function defaultCurrency(prices: (Money | undefined)[], regionCode: string): string {
  return prices.find((p) => p?.currencyCode)?.currencyCode ?? REGION_CURRENCY[regionCode] ?? "USD";
}

// ------------------------------------------------------------------ grouping

export type ServiceRow =
  | { kind: "google"; id: string; name: string; description: string; price?: Money; selected: boolean }
  | { kind: "own"; index: number; name: string; description: string; price?: Money; category: string };
export type ServiceGroup = {
  /** The category name, or "other". */
  key: string;
  label: string;
  rows: ServiceRow[];
  /** Services on the profile: ticked Google-list ones plus own ones. Unticked choices are not counted. */
  count: number;
};

/** `categories/gcid:web_designer` as "Web designer", for a category Google gave no name for. */
export const plainCategory = (name: string) =>
  categoryLabel(name);
const plainType = (id: string) => humanise(id);

export const OTHER = "other";

/**
 * One group per profile category (primary first, then the additional ones in profile order), then
 * "Other". A Google-list service sits in the first category that offers it; one no loaded category
 * offers, and an own service whose category is not on the profile, go to "Other". Nothing is dropped.
 */
export function groupServices(p: {
  own: OwnService[];
  selected: string[];
  items: ServiceItem[];
  details: Record<string, StructuredDetail>;
  categories: CategoryMeta[];
  primary: string;
  additional: string[];
  names: Record<string, string>;
}): ServiceGroup[] {
  const order = [p.primary, ...p.additional].filter((c, i, all) => c && all.indexOf(c) === i);
  const sent = new Map(
    structuredItems(p.selected, p.items, p.details).map((s) => [s.structuredServiceItem!.serviceTypeId, s]),
  );
  const google = (id: string, name: string): ServiceRow => {
    const item = sent.get(id);
    return {
      kind: "google",
      id,
      name,
      description: item?.structuredServiceItem?.description ?? "",
      ...(item?.price ? { price: item.price } : {}),
      selected: sent.has(id),
    };
  };
  const placed = new Set<string>();
  const groups: ServiceGroup[] = order.map((key) => {
    const rows: ServiceRow[] = [];
    for (const t of p.categories.find((c) => c.name === key)?.serviceTypes ?? []) {
      if (placed.has(t.serviceTypeId)) continue;
      placed.add(t.serviceTypeId);
      rows.push(google(t.serviceTypeId, t.displayName));
    }
    return { key, label: p.names[key] ?? plainCategory(key), rows, count: 0 };
  });
  const other: ServiceRow[] = p.selected
    .filter((id) => !placed.has(id))
    .map((id) => google(id, plainType(id)));
  p.own.forEach((o, index) => {
    const category = o.category || p.primary;
    const row: ServiceRow = {
      kind: "own",
      index,
      name: o.name,
      description: o.description,
      ...(o.price ? { price: o.price } : {}),
      category,
    };
    (groups.find((g) => g.key === category)?.rows ?? other).push(row);
  });
  if (other.length) groups.push({ key: OTHER, label: "Other", rows: other, count: 0 });
  for (const g of groups) g.count = g.rows.filter((r) => r.kind === "own" || r.selected).length;
  return groups;
}

/**
 * Rows whose name or description contains the text; groups with none are hidden while searching.
 * `of` is how many rows the group has in all (set while searching), so a header can read "3 of 69".
 */
export function filterGroups(
  groups: ServiceGroup[],
  query: string,
): { groups: (ServiceGroup & { of?: number })[]; matches: number } {
  const q = query.trim().toLowerCase();
  if (!q) return { groups, matches: groups.reduce((n, g) => n + g.rows.length, 0) };
  const out = groups
    .map((g) => ({
      ...g,
      of: g.rows.length,
      rows: g.rows.filter((r) => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)),
    }))
    .filter((g) => g.rows.length > 0);
  return { groups: out, matches: out.reduce((n, g) => n + g.rows.length, 0) };
}

/** The text split into pieces, flagging the ones that match the query (case-insensitive). */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const q = query.trim().toLowerCase();
  if (!q || !text) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, at)) {
    if (i > at) parts.push({ text: text.slice(at, i), match: false });
    parts.push({ text: text.slice(i, i + q.length), match: true });
    at = i + q.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}

// ------------------------------------------------------------------ currency

/** Listed first in the currency picker: the ones this agency's locations use. */
export const COMMON_CURRENCIES = ["INR", "USD", "AUD", "GBP", "CAD", "NZD", "EUR"];

/**
 * Codes for the currency picker: the common ones, then every other supported code in order. A code
 * already on the price stays in the list even if the runtime does not know it. `supported` is
 * `Intl.supportedValuesOf("currency")` where the runtime has it.
 */
export function currencyOptions(supported: readonly string[] | undefined, current?: string): string[] {
  const rest = [...new Set([...(supported ?? []), ...(current ? [current] : [])])]
    .filter((c) => !COMMON_CURRENCIES.includes(c))
    .sort();
  return [...COMMON_CURRENCIES, ...rest];
}

/** What the runtime supports, or undefined when it cannot say. */
export function supportedCurrencies(): string[] | undefined {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("currency");
  } catch {
    return undefined;
  }
}
