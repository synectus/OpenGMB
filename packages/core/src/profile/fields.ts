import { z } from "zod";
import {
  GOOGLE_DAYS,
  type GoogleAttribute,
  type GoogleAttributes,
  type GoogleLocation,
  type GoogleServiceItem,
} from "../google/client";
import { PROFILE_LIMITS } from "../config/profile-limits";
import { canonicalJson } from "../audit";
import { CoreError } from "../errors";

/** Our cap on a location's services. Google documents no limit; this is a conservative guard. */
export const SERVICE_ITEMS_MAX = 300;

/**
 * The editable profile, as the desired values of a change set (`ProfileFields`, every key optional:
 * absent = leave alone, null = clear where Google allows it) and as a normalised snapshot of what
 * Google has (`ProfileSnapshot`). Both go through the same normalisers, so "did this field change"
 * is a plain comparison and the stored `before` can be compared with a later live read.
 *
 * Only the content shapes are checked by zod; content RULES (hours overlap, description length,
 * phone format ...) are guardrails (packs/profile.ts), so a change set can exist while invalid.
 */
export const PROFILE_FIELDS = [
  "title",
  "description",
  "categories",
  "regularHours",
  "specialHours",
  "serviceItems",
  "serviceArea",
  "websiteUri",
  "openingDate",
  "phoneNumbers",
  "storeCode",
  "storefrontAddress",
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

const int = z.number().int();
const tod = z.object({ hours: int.optional(), minutes: int.optional() });
const date = z.object({ year: int.optional(), month: int.optional(), day: int.optional() });
const category = z.object({ name: z.string().min(1).max(200) });

export const attributeInput = z.object({
  values: z
    .array(z.union([z.boolean(), z.string().max(500), z.number()]))
    .max(50)
    .optional(),
  uriValues: z
    .array(z.object({ uri: z.string().max(2000) }))
    .max(10)
    .optional(),
  repeatedEnumValue: z
    .object({
      setValues: z.array(z.string().max(200)).max(100).optional(),
      unsetValues: z.array(z.string().max(200)).max(100).optional(),
    })
    .optional(),
});
export type AttributeValue = z.infer<typeof attributeInput>;

/** Attribute ids are `attributes/{id}` (the attributeMask form). null deletes the attribute. */
export const attributesInput = z.record(
  z
    .string()
    .regex(/^attributes\/[A-Za-z0-9_.-]+$/, "attribute names look like attributes/has_wifi"),
  attributeInput.nullable(),
);

/**
 * google.type.Money, the shape of a service item's price
 * (https://github.com/googleapis/googleapis/blob/master/google/type/money.proto):
 * currencyCode is a 3-letter ISO 4217 code, units is an int64 (a JSON string), nanos is in
 * -999,999,999..999,999,999, and units and nanos must not have opposite signs.
 */
const money = z
  .object({
    currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
    units: z.string().regex(/^[+-]?\d{1,18}$/).optional(),
    nanos: z.number().int().min(-999_999_999).max(999_999_999).optional(),
  })
  .refine(
    (m) => {
      const u = m.units === undefined ? 0 : Number(m.units);
      const n = m.nanos ?? 0;
      return !((u > 0 && n < 0) || (u < 0 && n > 0));
    },
    { message: "units and nanos must have the same sign" },
  );

/** One service item as sent to Google (free-form or structured), with an optional price. */
export const serviceItemInput = z.object({
    structuredServiceItem: z
      .object({
        serviceTypeId: z.string().max(200),
        description: z.string().max(PROFILE_LIMITS.serviceDescriptionMaxChars.limit).optional(),
      })
      .optional(),
    freeFormServiceItem: z
      .object({
        category: z.string().max(200),
        label: z.object({
          displayName: z.string().max(500),
          description: z.string().max(PROFILE_LIMITS.serviceDescriptionMaxChars.limit).optional(),
          languageCode: z.string().max(20).optional(),
        }),
      })
      .optional(),
    price: money.optional(),
});

/** Google: "a maximum of five addressLines values". */
export const ADDRESS_LINES_MAX = 5;

export const profileFieldsShape = {
  title: z.string().min(1).max(500).optional(),
  description: z.string().min(1).max(20_000).optional(),
  /** Category ids are Google's stable ids such as `categories/gcid:dentist` (free text in the mock). */
  categories: z
    .object({
      primaryCategory: category,
      additionalCategories: z.array(category).max(20).optional(),
    })
    .optional(),
  regularHours: z
    .object({
      periods: z
        .array(
          z.object({
            openDay: z.string().max(20),
            openTime: tod,
            closeDay: z.string().max(20),
            closeTime: tod,
          }),
        )
        .max(50),
    })
    .nullish(),
  specialHours: z
    .object({
      specialHourPeriods: z
        .array(
          z.object({
            startDate: date,
            endDate: date.optional(),
            openTime: tod.optional(),
            closeTime: tod.optional(),
            closed: z.boolean().optional(),
          }),
        )
        .max(200),
    })
    .nullish(),
  serviceItems: z.array(serviceItemInput)
    .max(SERVICE_ITEMS_MAX)
    .optional(),
  serviceArea: z
    .object({
      businessType: z.enum(["CUSTOMER_LOCATION_ONLY", "CUSTOMER_AND_BUSINESS_LOCATION"]),
      places: z
        .object({
          placeInfos: z
            .array(z.object({ placeName: z.string().max(300), placeId: z.string().max(300) }))
            .max(100),
        })
        .optional(),
    })
    .nullish(),
  websiteUri: z.string().max(2000).nullish(),
  openingDate: date.nullish(),
  phoneNumbers: z
    .object({
      primaryPhone: z.string().max(50).optional(),
      additionalPhones: z.array(z.string().max(50)).max(10).optional(),
    })
    .optional(),
  /** null clears the store code. */
  storeCode: z.string().max(500).nullish(),
  /** Whole address (cannot be cleared). regionCode is the CLDR region, e.g. US. */
  storefrontAddress: z
    .object({
      regionCode: z.string().min(2).max(10),
      postalCode: z.string().max(40).optional(),
      administrativeArea: z.string().max(100).optional(),
      locality: z.string().max(100).optional(),
      addressLines: z.array(z.string().max(200)).max(ADDRESS_LINES_MAX).optional(),
    })
    // PostalAddress parts the editor does not show (sublocality, languageCode ...) are kept as they are.
    .catchall(z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(500)).max(20)]))
    .optional(),
};

export const profileFieldsInput = z.object({
  ...profileFieldsShape,
  attributes: attributesInput.optional(),
});
export type ProfileFields = z.input<typeof profileFieldsInput>;

/** Values keyed by field, plus attribute values keyed by `attributes/{id}` (null = none). */
export type ProfileValues = {
  fields: Partial<Record<ProfileField, unknown>>;
  attributes: Record<string, unknown>;
};
export type ProfileSnapshot = ProfileValues;

// ---------------------------------------------------------------------------
// Normalisers: Google and input shapes both end up as the same canonical value (null = not set).
// ---------------------------------------------------------------------------

const num = (v: unknown) => (typeof v === "number" ? v : 0);
const nonEmpty = (o: Record<string, unknown>) => (Object.keys(o).length === 0 ? null : o);

type Tod = { hours?: number; minutes?: number } | undefined | null;
const normTod = (t: Tod) => ({ hours: num(t?.hours), minutes: num(t?.minutes) });
const todMinutes = (t: { hours: number; minutes: number }) => t.hours * 60 + t.minutes;

type DateIn = { year?: number; month?: number; day?: number } | undefined | null;
function normDate(d: DateIn): { year?: number; month?: number; day?: number } | null {
  if (!d) return null;
  const out: { year?: number; month?: number; day?: number } = {};
  if (d.year) out.year = d.year;
  if (d.month) out.month = d.month;
  if (d.day) out.day = d.day;
  return nonEmpty(out) as typeof out | null;
}
const dateKey = (d: { year?: number; month?: number; day?: number } | null) =>
  d ? d.year! * 10_000 + (d.month ?? 0) * 100 + (d.day ?? 0) : 0;

const dayRank = (d: string) => {
  const i = (GOOGLE_DAYS as readonly string[]).indexOf(d);
  return i === -1 ? 99 : i;
};

const sortedBy = <T>(list: T[]) =>
  [...list].sort((a, b) => cmp(canonicalJson(a), canonicalJson(b)));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function normRegularHours(v: unknown): unknown {
  const periods = (v as { periods?: GoogleLocation["regularHours"] & object } | null)?.periods;
  const list = (periods as unknown as NonNullable<GoogleLocation["regularHours"]>["periods"]) ?? [];
  if (!Array.isArray(list) || list.length === 0) return null;
  const norm = list.map((p) => ({
    openDay: p.openDay,
    openTime: normTod(p.openTime),
    closeDay: p.closeDay,
    closeTime: normTod(p.closeTime),
  }));
  norm.sort(
    (a, b) =>
      dayRank(a.openDay) - dayRank(b.openDay) ||
      todMinutes(a.openTime) - todMinutes(b.openTime) ||
      dayRank(a.closeDay) - dayRank(b.closeDay) ||
      todMinutes(a.closeTime) - todMinutes(b.closeTime),
  );
  return { periods: norm };
}

function normSpecialHours(v: unknown): unknown {
  const list = (v as NonNullable<GoogleLocation["specialHours"]> | null)?.specialHourPeriods;
  if (!Array.isArray(list) || list.length === 0) return null;
  const norm = list.map((p) => {
    const start = normDate(p.startDate) ?? {};
    if (p.closed === true) return { startDate: start, closed: true };
    return {
      startDate: start,
      endDate: normDate(p.endDate) ?? start,
      openTime: normTod(p.openTime),
      closeTime: normTod(p.closeTime),
    };
  });
  norm.sort((a, b) => dateKey(a.startDate) - dateKey(b.startDate));
  return { specialHourPeriods: norm };
}

function normCategories(v: unknown): unknown {
  const c = v as GoogleLocation["categories"] | null;
  if (!c?.primaryCategory?.name) return null;
  return {
    primaryCategory: { name: c.primaryCategory.name },
    additionalCategories: (c.additionalCategories ?? []).map((a) => ({ name: a.name })),
  };
}

/** Google omits a zero units or nanos, so a price is compared without them. */
type GoogleServiceItemPrice = NonNullable<GoogleServiceItem["price"]>;
function normPrice(p: GoogleServiceItemPrice | undefined): Record<string, unknown> | null {
  if (!p) return null;
  const units = p.units === undefined ? 0n : BigInt(p.units);
  const out = {
    ...(p.currencyCode ? { currencyCode: p.currencyCode } : {}),
    ...(units !== 0n ? { units: units.toString() } : {}),
    ...(p.nanos ? { nanos: p.nanos } : {}),
  };
  return Object.keys(out).length ? out : null;
}

function normServiceItems(v: unknown): unknown {
  if (!Array.isArray(v) || v.length === 0) return null;
  const items = (v as NonNullable<GoogleLocation["serviceItems"]>).map((s) => {
    const o: Record<string, unknown> = {};
    if (s.structuredServiceItem) {
      o.structuredServiceItem = {
        serviceTypeId: s.structuredServiceItem.serviceTypeId,
        ...(s.structuredServiceItem.description
          ? { description: s.structuredServiceItem.description }
          : {}),
      };
    }
    if (s.freeFormServiceItem) {
      const l = s.freeFormServiceItem.label;
      o.freeFormServiceItem = {
        category: s.freeFormServiceItem.category,
        label: {
          displayName: l.displayName,
          ...(l.description ? { description: l.description } : {}),
          ...(l.languageCode ? { languageCode: l.languageCode } : {}),
        },
      };
    }
    const price = normPrice(s.price);
    if (price) o.price = price;
    return o;
  });
  // Google removes duplicates and does not promise an order.
  const unique = [...new Map(items.map((i) => [canonicalJson(i), i])).values()];
  return sortedBy(unique);
}

/** Identity of a service for "already there": its name and category (or its structured type). */
function serviceKey(i: Record<string, unknown>): string {
  const f = i.freeFormServiceItem as { category: string; label: { displayName: string } } | undefined;
  if (f) return `free|${f.category}|${f.label.displayName.trim().toLowerCase()}`;
  const s = i.structuredServiceItem as { serviceTypeId: string } | undefined;
  return `structured|${s?.serviceTypeId ?? ""}`;
}

/**
 * The location's current normalised service list plus `add` (only the `send` indexes when given).
 * Every existing item is kept as it is; an item whose name and category are already there (or
 * repeated in `add`) is skipped.
 */
export function mergeServiceItems(current: unknown, add: unknown[], send?: number[]): unknown {
  const existing = Array.isArray(current) ? (current as Record<string, unknown>[]) : [];
  const seen = new Set(existing.map(serviceKey));
  const chosen = send ? add.filter((_, i) => send.includes(i)) : add;
  const fresh = (NORMALISE.serviceItems(chosen) as Record<string, unknown>[] | null ?? []).filter(
    (i) => !seen.has(serviceKey(i)) && seen.add(serviceKey(i)),
  );
  return fresh.length === 0 ? current : NORMALISE.serviceItems([...existing, ...fresh]);
}

export type ServiceSkipReason =
  | "category_not_on_location"
  | "type_not_offered"
  | "type_unverified"
  | "over_cap";
export type ServiceAddPlan = {
  /** Indexes into `add` that are sent to this location. */
  send: number[];
  /** Same name and category (or same structured type) already on the location, or repeated in `add`: unchanged. */
  alreadyThere: number[];
  skipped: { index: number; reason: ServiceSkipReason }[];
};

const categoryId = (c: string) => c.trim().replace(/^categories\//, "").toLowerCase();

/**
 * What adding `add` to this location would do, item by item (the Copy services flags).
 * With `checkOffers`, a free-form item whose category is not one of the location's is skipped, a
 * structured item is sent only when `structuredOk(index)` says its type is offered by the location's
 * categories (a verdict of `"unverified"` skips it too), and if the merged list would pass
 * SERVICE_ITEMS_MAX nothing is sent (no arbitrary truncation). Without it, only duplicates are set aside.
 */
export function planServiceAdds(
  snapshot: ProfileSnapshot,
  add: unknown[],
  opts: { checkOffers: boolean; structuredOk?: (index: number) => boolean | "unverified" },
): ServiceAddPlan {
  const existing = Array.isArray(snapshot.fields.serviceItems)
    ? (snapshot.fields.serviceItems as Record<string, unknown>[])
    : [];
  const seen = new Set(existing.map(serviceKey));
  const cats = snapshot.fields.categories as
    | { primaryCategory?: { name?: string }; additionalCategories?: { name?: string }[] }
    | null
    | undefined;
  const onLocation = new Set(
    [cats?.primaryCategory?.name, ...(cats?.additionalCategories ?? []).map((c) => c.name)]
      .filter((n): n is string => Boolean(n))
      .map(categoryId),
  );
  const plan: ServiceAddPlan = { send: [], alreadyThere: [], skipped: [] };
  add.forEach((raw, index) => {
    const item = (NORMALISE.serviceItems([raw]) as Record<string, unknown>[] | null)?.[0];
    if (!item) return;
    const key = serviceKey(item);
    if (seen.has(key)) return void plan.alreadyThere.push(index);
    if (opts.checkOffers) {
      const free = item.freeFormServiceItem as { category: string } | undefined;
      if (free && !onLocation.has(categoryId(free.category))) {
        return void plan.skipped.push({ index, reason: "category_not_on_location" });
      }
      if (!free) {
        const ok = opts.structuredOk?.(index) ?? false;
        if (ok !== true) {
          return void plan.skipped.push({ index, reason: ok === "unverified" ? "type_unverified" : "type_not_offered" });
        }
      }
    }
    seen.add(key);
    plan.send.push(index);
  });
  if (opts.checkOffers && existing.length + plan.send.length > SERVICE_ITEMS_MAX) {
    plan.skipped.push(...plan.send.map((index) => ({ index, reason: "over_cap" as const })));
    plan.send = [];
  }
  return plan;
}

function normServiceArea(v: unknown): unknown {
  const a = v as GoogleLocation["serviceArea"] | null;
  if (!a?.businessType) return null;
  const places = (a.places?.placeInfos ?? []).map((p) => ({
    placeName: p.placeName,
    placeId: p.placeId,
  }));
  return {
    businessType: a.businessType,
    places: { placeInfos: places.sort((x, y) => cmp(x.placeId, y.placeId)) },
  };
}

function normPhones(v: unknown): unknown {
  const p = v as GoogleLocation["phoneNumbers"] | null;
  if (!p || (!p.primaryPhone && !(p.additionalPhones?.length ?? 0))) return null;
  return {
    ...(p.primaryPhone ? { primaryPhone: p.primaryPhone } : {}),
    additionalPhones: p.additionalPhones ?? [],
  };
}

const normString = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);

/**
 * Trimmed parts, empty ones dropped, keys sorted; null without a region code. Parts this app does
 * not edit (sublocality, languageCode, organization ...) stay in the value, so a write that starts
 * from this snapshot sends them back unchanged (the patch replaces the whole address).
 */
function normAddress(v: unknown): unknown {
  const a = v as Record<string, unknown> | null;
  if (!a || typeof a !== "object" || typeof a.regionCode !== "string" || !a.regionCode.trim()) return null;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(a).sort()) {
    const x = a[k];
    if (typeof x === "string") {
      const t = x.trim();
      if (t) out[k] = k === "regionCode" ? t.toUpperCase() : t;
    } else if (Array.isArray(x)) {
      const list = x.map((y) => (typeof y === "string" ? y.trim() : y)).filter((y) => y !== "" && y != null);
      if (list.length) out[k] = list;
    } else if (x !== null && x !== undefined) {
      out[k] = x;
    }
  }
  return out;
}

export const NORMALISE: Record<ProfileField, (v: unknown) => unknown> = {
  title: normString,
  description: normString,
  categories: normCategories,
  regularHours: normRegularHours,
  specialHours: normSpecialHours,
  serviceItems: normServiceItems,
  serviceArea: normServiceArea,
  websiteUri: normString,
  openingDate: (v) => normDate(v as DateIn),
  phoneNumbers: normPhones,
  storeCode: (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null),
  storefrontAddress: normAddress,
};

/** Attribute value without output-only parts (`valueType`), keys in a fixed order. */
export function normAttribute(a: AttributeValue | GoogleAttribute | null | undefined): unknown {
  if (!a) return null;
  const g = a as AttributeValue;
  const out: AttributeValue = {};
  if (g.values?.length) out.values = g.values;
  if (g.uriValues?.length) out.uriValues = g.uriValues.map((u) => ({ uri: u.uri }));
  if (g.repeatedEnumValue) {
    const set = [...(g.repeatedEnumValue.setValues ?? [])].sort();
    const unset = [...(g.repeatedEnumValue.unsetValues ?? [])].sort();
    if (set.length || unset.length) {
      out.repeatedEnumValue = {
        ...(set.length ? { setValues: set } : {}),
        ...(unset.length ? { unsetValues: unset } : {}),
      };
    }
  }
  return nonEmpty(out as Record<string, unknown>);
}

/** What Google has now, normalised: every field is present (null when not set). */
export function snapshotFromGoogle(
  loc: GoogleLocation,
  attrs: GoogleAttributes | null,
): ProfileSnapshot {
  const raw: Record<ProfileField, unknown> = {
    title: loc.title,
    description: loc.profile?.description,
    categories: loc.categories,
    regularHours: loc.regularHours,
    specialHours: loc.specialHours,
    serviceItems: loc.serviceItems,
    serviceArea: loc.serviceArea,
    websiteUri: loc.websiteUri,
    openingDate: loc.openInfo?.openingDate,
    phoneNumbers: loc.phoneNumbers,
    storeCode: loc.storeCode,
    storefrontAddress: loc.storefrontAddress,
  };
  const fields: ProfileValues["fields"] = {};
  for (const f of PROFILE_FIELDS) fields[f] = NORMALISE[f](raw[f]);
  const attributes: Record<string, unknown> = {};
  for (const a of attrs?.attributes ?? []) attributes[a.name] = normAttribute(a);
  return { fields, attributes };
}

/** Re-normalise a snapshot that came back from a client (the propose input). */
export function snapshotFromJson(raw: unknown): ProfileSnapshot {
  const r = (raw ?? {}) as {
    fields?: Record<string, unknown>;
    attributes?: Record<string, unknown>;
  };
  const fields: ProfileValues["fields"] = {};
  for (const f of PROFILE_FIELDS) fields[f] = NORMALISE[f](r.fields?.[f]);
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r.attributes ?? {})) {
    attributes[k] = normAttribute(v as AttributeValue | null);
  }
  return { fields, attributes };
}

/** The desired values, normalised. Only keys the caller set. */
export function desiredValues(input: ProfileFields): ProfileValues {
  const fields: ProfileValues["fields"] = {};
  for (const f of PROFILE_FIELDS) {
    if (input[f] !== undefined) fields[f] = NORMALISE[f](input[f]);
  }
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.attributes ?? {})) attributes[k] = normAttribute(v);
  return { fields, attributes };
}

/**
 * One location's desired values for an `addServiceItems` request. `desired` carries the normalised
 * additions as `serviceItems` (so the change set's stored field names include Services); this swaps
 * in the location's merged list, which is what its target stores and applies.
 */
export function withMergedServices(
  desired: ProfileValues,
  snapshot: ProfileSnapshot,
  add: unknown[],
  send?: number[],
): ProfileValues {
  return {
    ...desired,
    fields: { ...desired.fields, serviceItems: mergeServiceItems(snapshot.fields.serviceItems, add, send) },
  };
}

/**
 * The location's current categories plus `add` as additional categories. The primary stays, and a
 * category already there (the primary or an additional one, compared without the `categories/` prefix)
 * is skipped. A location without a primary category cannot take additions.
 */
export function mergeCategories(current: unknown, add: { name: string }[]): unknown {
  const c = current as { primaryCategory?: { name?: string }; additionalCategories?: { name: string }[] } | null | undefined;
  const primary = c?.primaryCategory?.name;
  if (!primary) throw new CoreError("INVALID_INPUT", "This location has no primary category to add to");
  const existing = c?.additionalCategories ?? [];
  const seen = new Set([primary, ...existing.map((x) => x.name)].map(categoryId));
  const fresh = add.filter((x) => !seen.has(categoryId(x.name)) && seen.add(categoryId(x.name)));
  return fresh.length === 0
    ? current
    : NORMALISE.categories({ primaryCategory: { name: primary }, additionalCategories: [...existing, ...fresh] });
}

/** This location's snapshot with `add` merged into its categories (what its services are planned against). */
export function snapshotWithCategories(snapshot: ProfileSnapshot, add: { name: string }[]): ProfileSnapshot {
  return { ...snapshot, fields: { ...snapshot.fields, categories: mergeCategories(snapshot.fields.categories, add) } };
}

/** One location's desired values for an `addCategories` request: its merged category list. */
export function withMergedCategories(desired: ProfileValues, snapshot: ProfileSnapshot, add: { name: string }[]): ProfileValues {
  return { ...desired, fields: { ...desired.fields, categories: mergeCategories(snapshot.fields.categories, add) } };
}

export const same = (a: unknown, b: unknown) =>
  canonicalJson(a ?? null) === canonicalJson(b ?? null);

// ---------------------------------------------------------------------------
// Diff and masks
// ---------------------------------------------------------------------------

/** Field -> the Google updateMask entry for it. `description` is `profile`, the opening date is nested. */
export const FIELD_MASK: Record<ProfileField, string> = {
  title: "title",
  description: "profile",
  categories: "categories",
  regularHours: "regularHours",
  specialHours: "specialHours",
  serviceItems: "serviceItems",
  serviceArea: "serviceArea",
  websiteUri: "websiteUri",
  openingDate: "openInfo.openingDate",
  phoneNumbers: "phoneNumbers",
  storeCode: "storeCode",
  storefrontAddress: "storefrontAddress",
};

export type ProfileChange = { field: string; before: unknown; after: unknown };
export type ProfileDiff = {
  changes: ProfileChange[];
  /** Minimal locations.patch updateMask: changed fields only. */
  updateMask: string[];
  /** Minimal updateAttributes attributeMask: changed attributes only. */
  attributeMask: string[];
  /** Current values of the changed fields/attributes (what a later live read must still show). */
  before: ProfileValues;
  /** Desired values of the changed fields/attributes. */
  after: ProfileValues;
};

/** The fields and attributes of `desired` whose value differs from `current`. */
export function computeDiff(current: ProfileSnapshot, desired: ProfileValues): ProfileDiff {
  const diff: ProfileDiff = {
    changes: [],
    updateMask: [],
    attributeMask: [],
    before: { fields: {}, attributes: {} },
    after: { fields: {}, attributes: {} },
  };
  for (const f of PROFILE_FIELDS) {
    if (!(f in desired.fields)) continue;
    const before = current.fields[f] ?? null;
    const after = desired.fields[f] ?? null;
    if (same(before, after)) continue;
    diff.changes.push({ field: f, before, after });
    diff.updateMask.push(FIELD_MASK[f]);
    diff.before.fields[f] = before;
    diff.after.fields[f] = after;
  }
  for (const name of Object.keys(desired.attributes).sort()) {
    const before = current.attributes[name] ?? null;
    const after = desired.attributes[name] ?? null;
    if (same(before, after)) continue;
    diff.changes.push({ field: name, before, after });
    diff.attributeMask.push(name);
    diff.before.attributes[name] = before;
    diff.after.attributes[name] = after;
  }
  return diff;
}

/** The locations.patch body for the `fields` part of `values` (a cleared field is simply absent). */
export function locationPatch(values: ProfileValues): Partial<GoogleLocation> {
  const f = values.fields;
  const patch: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v !== null && v !== undefined) patch[k] = v;
  };
  put("title", f.title);
  if (f.description != null) patch.profile = { description: f.description };
  put("categories", f.categories);
  put("regularHours", f.regularHours);
  put("specialHours", f.specialHours);
  put("serviceItems", f.serviceItems);
  put("serviceArea", f.serviceArea);
  put("websiteUri", f.websiteUri);
  if (f.openingDate != null) patch.openInfo = { openingDate: f.openingDate };
  put("phoneNumbers", f.phoneNumbers);
  put("storeCode", f.storeCode);
  put("storefrontAddress", f.storefrontAddress);
  return patch as Partial<GoogleLocation>;
}

/** The updateAttributes body: attributes to set; deletions are in the mask only. */
export function attributesBody(name: string, values: ProfileValues): GoogleAttributes {
  return {
    name,
    attributes: Object.entries(values.attributes)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([n, v]) => ({ name: n, ...(v as AttributeValue) })),
  };
}

/** How one part (location fields, or attributes) of a target stands against Google's live values. */
export type PartState = "clear" | "already_applied" | "conflict";

export function partState(
  live: ProfileValues,
  before: ProfileValues,
  after: ProfileValues,
  part: "fields" | "attributes",
): PartState {
  const keys = Object.keys(after[part]);
  const pick = (v: ProfileValues) =>
    keys.map((k) => (v[part] as Record<string, unknown>)[k] ?? null);
  const liveVals = pick(live);
  if (same(liveVals, pick(after))) return "already_applied";
  if (same(liveVals, pick(before))) return "clear";
  return "conflict";
}

export const descriptionLimit = PROFILE_LIMITS.descriptionMaxChars.limit;

/** Field names (and attribute names) a change touches: what audit rows may say about it. */
export function touchedNames(values: ProfileValues): string[] {
  return [...Object.keys(values.fields), ...Object.keys(values.attributes)].sort();
}
