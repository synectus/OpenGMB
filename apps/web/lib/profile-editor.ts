// Pure logic for the profile editor (/locations/[id]/profile): the form, what changed, the exact
// `fields` sent to profile.preview / profile.propose, when Propose is allowed, the preview rows and
// reason texts. Client-safe: nothing from @opengmb/core at runtime.
import { failureLabel } from "./failure-labels";
import { attributeLabel, categoryLabel, humanise } from "./labels";
import { changedAttributes } from "./profile-pickers";

export const DAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;
export type Day = (typeof DAYS)[number];
export const DAY_LABEL: Record<Day, string> = {
  MONDAY: "Monday",
  TUESDAY: "Tuesday",
  WEDNESDAY: "Wednesday",
  THURSDAY: "Thursday",
  FRIDAY: "Friday",
  SATURDAY: "Saturday",
  SUNDAY: "Sunday",
};
const WEEKDAYS: readonly Day[] = ["TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

type Tod = { hours?: number; minutes?: number } | null | undefined;
export type Period = { openDay: string; openTime: Tod; closeDay: string; closeTime: Tod };
type SDate = { year?: number; month?: number; day?: number } | null | undefined;

const pad = (n: number) => String(n).padStart(2, "0");
export const todText = (t: Tod) => `${pad(t?.hours ?? 0)}:${pad(t?.minutes ?? 0)}`;
export function todOf(s: string): { hours: number; minutes: number } {
  const [h, m] = s.trim().split(":").map(Number);
  return { hours: h || 0, minutes: m || 0 };
}
export const dateText = (d: SDate) =>
  d?.year ? `${d.year}-${pad(d.month ?? 0)}-${pad(d.day ?? 0)}` : "";
function dateOf(s: string) {
  const [y, m, d] = s.trim().split("-").map(Number);
  return { year: y || 0, month: m || 0, day: d || 0 };
}
const list = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);

// ------------------------------------------------------------------ regular hours

export type Span = { from: string; to: string };
export type DayRow = { day: Day; open: boolean; spans: Span[] };
export const MAX_SPANS = 2;

/**
 * Google's regularHours as one row per day. A period that closes on another day cannot be drawn in
 * the grid; it is returned in `kept` and sent back unchanged with whatever the grid holds.
 */
export function gridFromHours(v: unknown): { rows: DayRow[]; kept: Period[] } {
  const periods = (v as { periods?: Period[] } | null)?.periods ?? [];
  const rows: DayRow[] = DAYS.map((day) => ({ day, open: false, spans: [] }));
  const kept: Period[] = [];
  for (const p of periods) {
    const row = rows.find((r) => r.day === p.openDay);
    if (!row || p.closeDay !== p.openDay) {
      kept.push(p);
      continue;
    }
    row.open = true;
    row.spans.push({ from: todText(p.openTime), to: todText(p.closeTime) });
  }
  for (const r of rows) r.spans.sort((a, b) => a.from.localeCompare(b.from));
  return { rows, kept };
}

/** Rows back to regularHours (same-day periods; 24:00 closes at midnight). Nothing open = clear. */
export function hoursFromGrid(rows: DayRow[], kept: Period[]): { periods: Period[] } | null {
  const periods: Period[] = rows.flatMap((r) =>
    r.open
      ? r.spans.map((s) => ({
          openDay: r.day,
          openTime: todOf(s.from),
          closeDay: r.day,
          closeTime: todOf(s.to),
        }))
      : [],
  );
  periods.push(...kept);
  return periods.length === 0 ? null : { periods };
}

export function setDayOpen(rows: DayRow[], day: Day, open: boolean): DayRow[] {
  return rows.map((r) =>
    r.day !== day
      ? r
      : { ...r, open, spans: open && r.spans.length === 0 ? [{ from: "09:00", to: "17:00" }] : r.spans },
  );
}

export function copyMondayToWeekdays(rows: DayRow[]): DayRow[] {
  const monday = rows.find((r) => r.day === "MONDAY");
  if (!monday) return rows;
  return rows.map((r) =>
    WEEKDAYS.includes(r.day)
      ? { ...r, open: monday.open, spans: monday.spans.map((s) => ({ ...s })) }
      : r,
  );
}

export function periodText(p: Period): string {
  const close =
    p.closeDay === p.openDay
      ? todText(p.closeTime)
      : `${DAY_LABEL[p.closeDay as Day] ?? p.closeDay} ${todText(p.closeTime)}`;
  return `${DAY_LABEL[p.openDay as Day] ?? p.openDay} ${todText(p.openTime)} to ${close}`;
}

// ------------------------------------------------------------------ special hours (moved from components/profile-forms.tsx)

export type SpecialRow = { date: string; closed: boolean; open: string; close: string };

export function rowsFromSpecial(v: unknown): SpecialRow[] {
  const periods =
    (
      v as {
        specialHourPeriods?: { startDate: SDate; closed?: boolean; openTime?: Tod; closeTime?: Tod }[];
      } | null
    )?.specialHourPeriods ?? [];
  return periods.map((p) => ({
    date: dateText(p.startDate),
    closed: p.closed === true,
    open: todText(p.openTime),
    close: todText(p.closeTime),
  }));
}

export function specialFromRows(rows: SpecialRow[]) {
  return rows.length === 0
    ? null
    : {
        specialHourPeriods: rows.map((r) =>
          r.closed
            ? { startDate: dateOf(r.date), closed: true }
            : {
                startDate: dateOf(r.date),
                endDate: dateOf(r.date),
                openTime: todOf(r.open),
                closeTime: todOf(r.close),
              },
        ),
      };
}

// ------------------------------------------------------------------ attributes (moved from components/profile-forms.tsx)

export type AttrRow = { name: string; kind: "values" | "uri"; text: string; remove: boolean };

/** `true, false, wifi` -> [true, false, "wifi"]; URL attributes use uriValues. */
export function attributeFromRow(r: AttrRow) {
  if (r.kind === "uri") return { uriValues: [{ uri: r.text.trim() }] };
  return {
    values: r.text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s === "true" ? true : s === "false" ? false : s)),
  };
}

export function rowsFromAttributes(attrs: { name: string; value: unknown }[]): AttrRow[] {
  return attrs.map((a) => {
    const v = (a.value ?? {}) as { values?: unknown[]; uriValues?: { uri: string }[] };
    return v.uriValues
      ? { name: a.name, kind: "uri", text: v.uriValues[0]?.uri ?? "", remove: false }
      : { name: a.name, kind: "values", text: (v.values ?? []).join(", "), remove: false };
  });
}

// ------------------------------------------------------------------ services

export type ServiceItem = {
  structuredServiceItem?: { serviceTypeId: string; description?: string };
  freeFormServiceItem?: {
    category: string;
    label: { displayName: string; description?: string; languageCode?: string };
  };
  /** google.type.Money. Not editable here; carried through so a save does not erase it. */
  price?: { currencyCode?: string; units?: string; nanos?: number };
};
export type Money = NonNullable<ServiceItem["price"]>;
export type OwnService = {
  name: string;
  description: string;
  languageCode?: string;
  /** The service's own Google category. A service added in the form has none and takes the primary. */
  category?: string;
  price?: ServiceItem["price"];
};

export function splitServices(v: unknown): {
  own: OwnService[];
  structured: ServiceItem[];
  category: string | null;
} {
  const items = Array.isArray(v) ? (v as ServiceItem[]) : [];
  return {
    own: items.flatMap((s) =>
      s.freeFormServiceItem
        ? [
            {
              category: s.freeFormServiceItem.category,
              ...(s.price ? { price: s.price } : {}),
              name: s.freeFormServiceItem.label.displayName,
              description: s.freeFormServiceItem.label.description ?? "",
              ...(s.freeFormServiceItem.label.languageCode
                ? { languageCode: s.freeFormServiceItem.label.languageCode }
                : {}),
            },
          ]
        : [],
    ),
    structured: items.filter((s) => s.structuredServiceItem),
    category: items.find((s) => s.freeFormServiceItem)?.freeFormServiceItem?.category ?? null,
  };
}

/**
 * Google's structured services stay as they are; own services become free-form items, each in its
 * own category (`category` is only for a service that has none yet).
 */
export function servicesFrom(
  own: OwnService[],
  structured: ServiceItem[],
  category: string,
): ServiceItem[] {
  return [
    ...structured,
    ...own
      .filter((o) => o.name.trim())
      .map((o) => ({
        freeFormServiceItem: {
          category: o.category || category,
          label: {
            displayName: o.name.trim(),
            ...(o.description.trim() ? { description: o.description.trim() } : {}),
            ...(o.languageCode ? { languageCode: o.languageCode } : {}),
          },
        },
        ...(o.price ? { price: o.price } : {}),
      })),
  ];
}

// ------------------------------------------------------------------ service area

export type AreaType = "" | "CUSTOMER_LOCATION_ONLY" | "CUSTOMER_AND_BUSINESS_LOCATION";
export type Place = { placeName: string; placeId: string };
export type Area = { type: AreaType; places: Place[] };
export const AREA_TYPES: { value: AreaType; label: string }[] = [
  { value: "", label: "Not a service area business" },
  { value: "CUSTOMER_LOCATION_ONLY", label: "Customer location only" },
  { value: "CUSTOMER_AND_BUSINESS_LOCATION", label: "Customer and business location" },
];

export function areaFrom(v: unknown): Area {
  const a = v as { businessType?: AreaType; places?: { placeInfos?: Place[] } } | null;
  return {
    type: a?.businessType ?? "",
    places: (a?.places?.placeInfos ?? []).map((p) => ({ placeName: p.placeName, placeId: p.placeId })),
  };
}

export function areaValue(a: Area): unknown {
  return a.type ? { businessType: a.type, places: { placeInfos: a.places } } : null;
}

const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;
export function addPlace(
  a: Area,
  name: string,
  id: string,
  max: number,
): { area: Area } | { error: string } {
  const placeName = name.trim();
  const placeId = id.trim();
  if (!placeName) {
    return { error: "INVALID_INPUT: Type the place name as Google shows it, for example Rivermoor, TX." };
  }
  if (!PLACE_ID.test(placeId)) {
    return { error: "INVALID_INPUT: A Google place id is 10 or more letters, digits, - or _." };
  }
  if (a.places.some((p) => p.placeId === placeId)) {
    return { error: "INVALID_INPUT: That place is already listed." };
  }
  if (a.places.length >= max) return { error: `INVALID_INPUT: At most ${max} places.` };
  return { area: { ...a, places: [...a.places, { placeName, placeId }] } };
}

/** Selected service type ids as items: an item Google already had keeps its description. */
export function structuredItems(
  selected: string[],
  existing: ServiceItem[],
  details: Record<string, StructuredDetail> = {},
): ServiceItem[] {
  return selected.map((id) => {
    const base = existing.find((s) => s.structuredServiceItem?.serviceTypeId === id) ?? {
      structuredServiceItem: { serviceTypeId: id },
    };
    const d = details[id];
    if (!d) return base;
    const { description: was, ...rest } = base.structuredServiceItem!;
    const description = d.description === undefined ? was : d.description.trim();
    const { price: wasPrice, ...top } = base;
    const price = d.price === undefined ? wasPrice : (d.price ?? undefined);
    return {
      ...top,
      structuredServiceItem: { ...rest, ...(description ? { description } : {}) },
      ...(price ? { price } : {}),
    };
  });
}

/** Money back to the text a person types: at least two decimals when there are any, none when whole. */
export function moneyToAmount(m: Money | undefined | null): string {
  if (!m) return "";
  const units = m.units ?? "0";
  const frac = String(m.nanos ?? 0).padStart(9, "0").replace(/0+$/, "");
  return frac ? `${units}.${frac.padEnd(2, "0")}` : units;
}

export function priceText(m: Money | undefined | null): string {
  return m ? `${m.currencyCode ?? ""} ${moneyToAmount(m)}`.trim() : "";
}

/** An edit to a Google-list service: description text, and a price (null removes it). Unset keeps Google's. */
export type StructuredDetail = { description?: string; price?: ServiceItem["price"] | null };

// ------------------------------------------------------------------ the form

export type ProfileForm = {
  title: string;
  description: string;
  primaryCategory: string;
  additionalCategories: string[];
  hours: DayRow[];
  special: SpecialRow[];
  own: OwnService[];
  attributes: Record<string, unknown>;
  /** Selected structured service type ids. */
  structured: string[];
  /** Edits to the description or price of Google-list services, by service type id. */
  structuredDetails: Record<string, StructuredDetail>;
  area: Area;
  website: string;
  phone: string;
  morePhones: string[];
  opening: string;
  storeCode: string;
  address: AddressForm;
};

/** The address as typed: one box per part; `lines` is one street line per row. */
export type AddressForm = { country: string; lines: string; city: string; region: string; postal: string };
export const ADDRESS_LINES_MAX = 5;

/**
 * The address as profile fields carry it: Google's current address (`base`) with only the typed
 * parts replaced, so parts the form does not show (sublocality, languageCode ...) are sent back
 * unchanged. null when none of the shown parts is filled in.
 */
export function addressValue(a: AddressForm, base: Record<string, unknown> | null = null) {
  const lines = a.lines.split("\n").map((x) => x.trim()).filter(Boolean);
  if (!lines.length && !a.city.trim() && !a.region.trim() && !a.postal.trim()) return null;
  const out: Record<string, unknown> = { ...(base ?? {}), regionCode: a.country.trim().toUpperCase() };
  const put = (k: string, v: unknown) => (v ? (out[k] = v) : delete out[k]);
  put("postalCode", a.postal.trim());
  put("administrativeArea", a.region.trim());
  put("locality", a.city.trim());
  put("addressLines", lines.length ? lines : null);
  return out;
}

const ADDRESS_PART_LABEL: Record<string, string> = {
  addressLines: "Street",
  locality: "City",
  administrativeArea: "State or region",
  postalCode: "Postal code",
  regionCode: "Country",
};

/** Only the address parts that differ, one line each ("City: Rivermoor"); the full address when it is new. */
export function addressChange(before: unknown, after: unknown): { now: string; next: string } {
  const a = (before ?? null) as Record<string, unknown> | null;
  const b = (after ?? null) as Record<string, unknown> | null;
  if (!a || !b) return { now: addressText(a), next: addressText(b) };
  const now: string[] = [];
  const next: string[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null)) continue;
    const label = ADDRESS_PART_LABEL[k] ?? humanise(k);
    const text = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? "Not set"));
    now.push(`${label}: ${text(a[k])}`);
    next.push(`${label}: ${text(b[k])}`);
  }
  return { now: now.join("\n"), next: next.join("\n") };
}

/** One line for the preview: street, city, region and postal code, country. */
export function addressText(v: unknown): string {
  const a = v as { regionCode?: string; postalCode?: string; administrativeArea?: string; locality?: string; addressLines?: string[] } | null;
  if (!a) return "Not set";
  return [
    ...(a.addressLines ?? []),
    a.locality,
    [a.administrativeArea, a.postalCode].filter(Boolean).join(" "),
    a.regionCode,
  ].filter(Boolean).join(", ");
}

/** Cheap checks before Preview: the same rules the guardrails enforce, said in plain words. */
export function addressProblem(a: AddressForm): string | null {
  const v = addressValue(a);
  if (!v) return null;
  if (!/^[A-Za-z]{2}$/.test(a.country.trim())) return "Use a two-letter country code, for example US.";
  const lines = (v.addressLines as string[] | undefined) ?? [];
  if (lines.length > ADDRESS_LINES_MAX) return `Use at most ${ADDRESS_LINES_MAX} address lines.`;
  if (lines.length === 0 && !v.locality) return "Add a street line or a city.";
  return null;
}
/** What the form cannot show but must send back unchanged. */
export type BuildContext = {
  kept: Period[];
  structured: ServiceItem[];
  serviceCategory: string;
  originalAttributes: Record<string, unknown>;
  /** Google's address as it is now, for the parts the form does not show. */
  originalAddress: Record<string, unknown> | null;
};

export function formFromProfile(
  profile: { fields: Record<string, unknown>; attributes: Record<string, unknown> },
  regionCode = "",
): { form: ProfileForm; ctx: BuildContext } {
  const f = profile.fields;
  const cats = (f.categories ?? null) as {
    primaryCategory?: { name: string };
    additionalCategories?: { name: string }[];
  } | null;
  const phones = (f.phoneNumbers ?? null) as {
    primaryPhone?: string;
    additionalPhones?: string[];
  } | null;
  const addr = (f.storefrontAddress ?? null) as {
    regionCode?: string;
    postalCode?: string;
    administrativeArea?: string;
    locality?: string;
    addressLines?: string[];
  } | null;
  const { rows, kept } = gridFromHours(f.regularHours);
  const services = splitServices(f.serviceItems);
  return {
    form: {
      title: (f.title as string | null) ?? "",
      description: (f.description as string | null) ?? "",
      primaryCategory: cats?.primaryCategory?.name ?? "",
      additionalCategories: (cats?.additionalCategories ?? []).map((c) => c.name),
      hours: rows,
      special: rowsFromSpecial(f.specialHours),
      own: services.own,
      attributes: { ...profile.attributes },
      structured: services.structured.map((s) => s.structuredServiceItem!.serviceTypeId),
      structuredDetails: {},
      area: areaFrom(f.serviceArea),
      website: (f.websiteUri as string | null) ?? "",
      phone: phones?.primaryPhone ?? "",
      morePhones: phones?.additionalPhones ?? [],
      opening: dateText(f.openingDate as SDate),
      storeCode: (f.storeCode as string | null) ?? "",
      address: {
        country: addr?.regionCode ?? regionCode,
        lines: (addr?.addressLines ?? []).join("\n"),
        city: addr?.locality ?? "",
        region: addr?.administrativeArea ?? "",
        postal: addr?.postalCode ?? "",
      },
    },
    ctx: {
      kept,
      structured: services.structured,
      serviceCategory: services.category ?? cats?.primaryCategory?.name ?? "",
      originalAttributes: { ...profile.attributes },
      originalAddress: addr as Record<string, unknown> | null,
    },
  };
}

/** Each field's label and the value that would be sent: compared by value, so undoing an edit is no change. */
const FIELDS: { label: string; value: (f: ProfileForm, c: BuildContext) => unknown }[] = [
  { label: "Name", value: (f) => f.title.trim() },
  { label: "Description", value: (f) => f.description.trim() },
  { label: "Primary category", value: (f) => f.primaryCategory.trim() },
  { label: "Additional categories", value: (f) => list(f.additionalCategories) },
  { label: "Regular hours", value: (f, c) => hoursFromGrid(f.hours, c.kept) },
  { label: "Special hours", value: (f) => specialFromRows(f.special) },
  { label: "Services", value: (f, c) => servicesFrom(f.own, structuredItems(f.structured, c.structured, f.structuredDetails), c.serviceCategory) },
  { label: "Attributes", value: (f, c) => changedAttributes(c.originalAttributes, f.attributes) },
  { label: "Service area", value: (f) => areaValue(f.area) },
  { label: "Website", value: (f) => f.website.trim() },
  { label: "Primary phone", value: (f) => f.phone.trim() },
  { label: "Additional phones", value: (f) => list(f.morePhones) },
  { label: "Opening date", value: (f) => f.opening.trim() },
  { label: "Store code", value: (f) => f.storeCode.trim() },
  { label: "Address", value: (f, c) => addressValue(f.address, c.originalAddress) },
];

export function changedLabels(initial: ProfileForm, now: ProfileForm, ctx: BuildContext): string[] {
  return FIELDS.filter(
    (x) => JSON.stringify(x.value(initial, ctx)) !== JSON.stringify(x.value(now, ctx)),
  ).map((x) => x.label);
}

export function changeSummary(labels: string[]): string {
  if (labels.length === 0) return "No changes yet";
  return `${labels.length} ${labels.length === 1 ? "field" : "fields"} changed: ${labels.join(", ")}`;
}

/**
 * The `fields` for profile.preview and profile.propose: only what changed. Name and description
 * cannot be cleared (Google requires them), so an emptied one is not sent.
 */
export function buildFields(
  initial: ProfileForm,
  now: ProfileForm,
  ctx: BuildContext,
): Record<string, unknown> {
  const changed = new Set(changedLabels(initial, now, ctx));
  const has = (...labels: string[]) => labels.some((l) => changed.has(l));
  const out: Record<string, unknown> = {};
  if (has("Name") && now.title.trim()) out.title = now.title.trim();
  if (has("Description") && now.description.trim()) out.description = now.description.trim();
  if (has("Primary category", "Additional categories") && now.primaryCategory.trim()) {
    out.categories = {
      primaryCategory: { name: now.primaryCategory.trim() },
      additionalCategories: list(now.additionalCategories).map((name) => ({ name })),
    };
  }
  if (has("Regular hours")) out.regularHours = hoursFromGrid(now.hours, ctx.kept);
  if (has("Special hours")) out.specialHours = specialFromRows(now.special);
  if (has("Services")) out.serviceItems = servicesFrom(
      now.own,
      structuredItems(now.structured, ctx.structured, now.structuredDetails),
      ctx.serviceCategory,
    );
  if (has("Attributes")) out.attributes = changedAttributes(ctx.originalAttributes, now.attributes);
  if (has("Service area")) out.serviceArea = areaValue(now.area);
  if (has("Website")) out.websiteUri = now.website.trim() || null;
  if (has("Primary phone", "Additional phones")) {
    out.phoneNumbers = { primaryPhone: now.phone.trim(), additionalPhones: list(now.morePhones) };
  }
  if (has("Opening date")) out.openingDate = now.opening.trim() ? dateOf(now.opening) : null;
  if (has("Store code")) out.storeCode = now.storeCode.trim() || null;
  // An address cannot be cleared on Google, so an emptied one is not sent.
  if (has("Address") && addressValue(now.address, ctx.originalAddress)) {
    out.storefrontAddress = addressValue(now.address, ctx.originalAddress);
  }
  return out;
}

// ------------------------------------------------------------------ propose

export type PreviewLike = {
  noChange: boolean;
  error: string | null;
  guardrail: { ok: boolean; violations: { severity: "block" | "warn" }[] } | null;
};
export type ProposeState = { kind: "ready" | "disabled" | "hidden"; note: string | null };

/** Propose only what was previewed: the previewed `fields` must equal the current ones byte for byte. */
export function proposeState(p: {
  preview: PreviewLike | null;
  previewKey: string | null;
  currentKey: string;
  acknowledged: boolean;
}): ProposeState {
  if (!p.preview || p.previewKey === null) return { kind: "disabled", note: "Preview first" };
  if (p.previewKey !== p.currentKey) {
    return { kind: "disabled", note: "Changed since the preview. Preview again." };
  }
  if (p.preview.error) return { kind: "disabled", note: "Google could not be read. Preview again." };
  if (p.preview.noChange) {
    return { kind: "disabled", note: "No change: these values already match Google." };
  }
  const g = p.preview.guardrail;
  if (g && !g.ok) return { kind: "hidden", note: "Fix these to propose." };
  if (g?.violations.some((v) => v.severity === "warn") && !p.acknowledged) {
    return { kind: "disabled", note: "Acknowledge the warnings to propose." };
  }
  return { kind: "ready", note: null };
}

// ------------------------------------------------------------------ preview rows

const FIELD_NAMES: Record<string, string> = {
  title: "Name",
  description: "Description",
  categories: "Categories",
  regularHours: "Regular hours",
  specialHours: "Special hours",
  serviceItems: "Services",
  serviceArea: "Service area",
  websiteUri: "Website",
  openingDate: "Opening date",
  phoneNumbers: "Phone numbers",
  storeCode: "Store code",
  storefrontAddress: "Address",
};
export function fieldName(field: string): string {
  if (field.startsWith("attributes/")) return `Attribute: ${attributeLabel(field)}`;
  return FIELD_NAMES[field] ?? humanise(field);
}

const NOT_SET = "Not set";
const AREA_LABEL: Record<string, string> = Object.fromEntries(
  AREA_TYPES.filter((t) => t.value).map((t) => [t.value, t.label]),
);

const serviceName = (s: ServiceItem) =>
  s.freeFormServiceItem?.label.displayName ?? s.structuredServiceItem?.serviceTypeId ?? "";
/** One service as a line: name, price, description. */
function serviceLine(s: ServiceItem, catName?: (n: string) => string): string {
  const description = s.freeFormServiceItem?.label.description ?? s.structuredServiceItem?.description;
  const name = s.freeFormServiceItem && catName
    ? `${serviceName(s)} (${catName(s.freeFormServiceItem.category)})`
    : serviceName(s);
  return [name, priceText(s.price), description].filter(Boolean).join(" · ");
}

/** The services that differ, as lines: unchanged ones are left out so 268 services do not fill the preview. */
function serviceChanges(before: unknown, after: unknown, catName: (n: string) => string) {
  const lines = (v: unknown) => {
    const seen = new Map<string, number>();
    return new Map(
      (Array.isArray(v) ? (v as ServiceItem[]) : []).map((s) => {
        const base = s.freeFormServiceItem ? `f:${s.freeFormServiceItem.category}|${serviceName(s)}` : `s:${serviceName(s)}`;
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        return [`${base}#${n}`, serviceLine(s, catName)] as const;
      }),
    );
  };
  const a = lines(before);
  const b = lines(after);
  const keys = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
  return {
    now: keys.flatMap((k) => a.get(k) ?? []).join("\n") || NOT_SET,
    next: keys.flatMap((k) => b.get(k) ?? []).join("\n") || NOT_SET,
  };
}

/** The same differences as `serviceChanges`, one entry per service instead of lines of text. */
export function serviceChangeCards(before: unknown, after: unknown, catName: (n: string) => string): ServiceChange[] {
  const index = (v: unknown) => {
    const seen = new Map<string, number>();
    return new Map(
      (Array.isArray(v) ? (v as ServiceItem[]) : []).map((s) => {
        const base = s.freeFormServiceItem ? `f:${s.freeFormServiceItem.category}|${serviceName(s)}` : `s:${serviceName(s)}`;
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        return [`${base}#${n}`, s] as const;
      }),
    );
  };
  const side = (s: ServiceItem | undefined) =>
    s
      ? {
          price: priceText(s.price),
          description: s.freeFormServiceItem?.label.description ?? s.structuredServiceItem?.description ?? "",
        }
      : null;
  const a = index(before);
  const b = index(after);
  const out: ServiceChange[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k);
    const y = b.get(k);
    if (x && y && serviceLine(x, catName) === serviceLine(y, catName)) continue;
    const s = (y ?? x)!;
    out.push({
      name: serviceName(s),
      category: s.freeFormServiceItem ? catName(s.freeFormServiceItem.category) : null,
      before: side(x),
      after: side(y),
    });
  }
  return out;
}

function valueText(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return NOT_SET;
  if (typeof v === "string") return v;
  if (field === "openingDate") return dateText(v as SDate) || NOT_SET;
  if (field === "storefrontAddress") return addressText(v);
  if (field === "specialHours") {
    return rowsFromSpecial(v)
      .map((r) => `${r.date} · ${r.closed ? "Closed" : `${r.open} to ${r.close}`}`)
      .join("\n");
  }
  if (field === "serviceItems") return (v as ServiceItem[]).map((s) => serviceLine(s)).join("\n");
  if (field === "serviceArea") {
    const a = areaFrom(v);
    return [AREA_LABEL[a.type] ?? a.type, ...a.places.map((p) => p.placeName)].join("\n");
  }
  if (field.startsWith("attributes/")) {
    const a = v as {
      values?: unknown[];
      uriValues?: { uri: string }[];
      repeatedEnumValue?: { setValues?: string[] };
    };
    if (a.uriValues?.length) return a.uriValues.map((u) => u.uri).join("\n");
    if (a.values?.length) {
      return a.values.map((x) => (x === true ? "Yes" : x === false ? "No" : String(x))).join(", ");
    }
    if (a.repeatedEnumValue?.setValues?.length) return a.repeatedEnumValue.setValues.join(", ");
  }
  return JSON.stringify(v);
}

function byDay(v: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of (v as { periods?: Period[] } | null)?.periods ?? []) {
    const text =
      p.closeDay === p.openDay
        ? `${todText(p.openTime)} to ${todText(p.closeTime)}`
        : `${todText(p.openTime)} to ${DAY_LABEL[p.closeDay as Day] ?? p.closeDay} ${todText(p.closeTime)}`;
    out.set(p.openDay, out.has(p.openDay) ? `${out.get(p.openDay)}, ${text}` : text);
  }
  return out;
}

/** One changed service, for the stacked cards on a phone. A null side means the service was not there. */
export type ServiceChange = {
  name: string;
  category: string | null;
  before: { price: string; description: string } | null;
  after: { price: string; description: string } | null;
};
export type PreviewRow = { field: string; now: string; next: string };

/** Core's per-field changes as rows people read: hours per day, categories by name, phones split. */
export function previewRows(
  changes: { field: string; before: unknown; after: unknown }[],
  categoryNames: Record<string, string>,
): PreviewRow[] {
  const out: PreviewRow[] = [];
  const push = (field: string, now: string, next: string) => {
    if (now !== next) out.push({ field, now, next });
  };
  const cat = (n: string) => categoryLabel(n, categoryNames);
  type Cats = { primaryCategory?: { name: string }; additionalCategories?: { name: string }[] } | null;
  type Phones = { primaryPhone?: string; additionalPhones?: string[] } | null;
  for (const c of changes) {
    if (c.field === "regularHours") {
      const before = byDay(c.before);
      const after = byDay(c.after);
      for (const d of DAYS) {
        push(`${DAY_LABEL[d]} hours`, before.get(d) ?? "Closed", after.get(d) ?? "Closed");
      }
    } else if (c.field === "categories") {
      const a = c.before as Cats;
      const b = c.after as Cats;
      const primary = (x: Cats) => (x?.primaryCategory ? cat(x.primaryCategory.name) : NOT_SET);
      const more = (x: Cats) =>
        (x?.additionalCategories ?? []).map((y) => cat(y.name)).join(", ") || "None";
      push("Primary category", primary(a), primary(b));
      push("Additional categories", more(a), more(b));
    } else if (c.field === "phoneNumbers") {
      const a = c.before as Phones;
      const b = c.after as Phones;
      push("Primary phone", a?.primaryPhone || NOT_SET, b?.primaryPhone || NOT_SET);
      push(
        "Additional phones",
        (a?.additionalPhones ?? []).join(", ") || "None",
        (b?.additionalPhones ?? []).join(", ") || "None",
      );
    } else if (c.field === "storefrontAddress") {
      const r = addressChange(c.before, c.after);
      push("Address", r.now, r.next);
    } else if (c.field === "serviceItems") {
      const r = serviceChanges(c.before, c.after, cat);
      push("Services", r.now, r.next);
    } else {
      out.push({
        field: fieldName(c.field),
        now: valueText(c.field, c.before),
        next: valueText(c.field, c.after),
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ reasons and links

/** `conflict: Changed on Google ...` for codes `failureLabel` knows; any other code as it is. */
export function reasonText(code: string): string {
  const label = failureLabel(code);
  return label !== code ? `${label}.` : humanise(code);
}

const PLACE_ACTION_NAMES: Record<string, string> = {
  APPOINTMENT: "Appointment",
  ONLINE_APPOINTMENT: "Online appointment",
  DINING_RESERVATION: "Dining reservation",
  FOOD_ORDERING: "Food ordering",
  FOOD_DELIVERY: "Food delivery",
  FOOD_TAKEOUT: "Food takeout",
  SHOP_ONLINE: "Shop online",
};
export const placeActionLabel = (type: string) =>
  PLACE_ACTION_NAMES[type] ?? humanise(type);

export const linkOpText = (kind: "add" | "update" | "delete") =>
  `${{ add: "Adding link", update: "Updating link", delete: "Removing link" }[kind]}: waiting for Google`;

export function linkFailure(error: string | null): string {
  return error === "google_writes_disabled"
    ? `${failureLabel(error)}.`
    : `Google did not accept it${error ? ` (${humanise(error).toLowerCase()})` : ""}`;
}
