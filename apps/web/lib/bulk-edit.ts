// Pure logic for /locations/bulk-edit. Client-safe; no runtime import from core or components.
import { failureLabel } from "./failure-labels";
import { profileFieldLabel, profileFieldsLabel } from "./labels";
import type { TimeFormat } from "./time-format";

type Tone = "good" | "warn" | "bad" | "info" | "neutral";

// ------------------------------------------------------------------ workspace and locations

export type BulkLoc = {
  id: string;
  name: string;
  addressSummary?: string | null;
  phone?: string | null;
  status: string;
  googleLocationId: string | null;
  needsRelink: boolean;
};
export type BulkGroup = { id: string; name: string; locationIds: string[] };

export function ineligibleReason(l: BulkLoc): string | null {
  if (l.status !== "active") return "inactive";
  if (!l.googleLocationId || l.needsRelink) return "not linked to Google";
  return null;
}
export const eligibleIds = (locs: BulkLoc[]) => locs.filter((l) => !ineligibleReason(l)).map((l) => l.id);
/** Most locations one change covers. apps/web/lib/bulk-edit.test.ts pins it to core's PROFILE_BATCH_MAX_LOCATIONS. */
export const BULK_MAX_LOCATIONS = 100;
export function quickSelect(g: BulkGroup, locs: BulkLoc[]): string[] {
  const ok = new Set(eligibleIds(locs));
  return g.locationIds.filter((id) => ok.has(id)).slice(0, BULK_MAX_LOCATIONS);
}
/** The batch "All" stands for: the first editable locations, by the list's order, up to the cap. */
const allBatch = (locs: BulkLoc[]) => eligibleIds(locs).slice(0, BULK_MAX_LOCATIONS);
export const allPicked = (picked: string[], locs: BulkLoc[]) => {
  const batch = allBatch(locs);
  return batch.length > 0 && batch.every((id) => picked.includes(id));
};
export const toggleAllIds = (picked: string[], locs: BulkLoc[]): string[] => (allPicked(picked, locs) ? [] : allBatch(locs));
export function capNote(locs: BulkLoc[]): string | null {
  const n = eligibleIds(locs).length;
  return n > BULK_MAX_LOCATIONS
    ? `One change covers up to ${BULK_MAX_LOCATIONS} locations. All picks the first ${BULK_MAX_LOCATIONS} by name; make another change for the other ${n - BULK_MAX_LOCATIONS}.`
    : null;
}

// ------------------------------------------------------------------ fields

export const BULK_FIELDS = [
  { key: "regularHours", label: "Regular hours (replaces each location's hours)" },
  { key: "specialHours", label: "Special hours" },
  { key: "attributes", label: "Attributes (only the ones listed are touched)" },
  { key: "description", label: "Description" },
  { key: "websiteUri", label: "Website (empty clears it)" },
  { key: "title", label: "Title" },
  { key: "categories", label: "Categories" },
  { key: "serviceItems", label: "Services" },
  { key: "serviceArea", label: "Service area" },
  { key: "openingDate", label: "Opening date" },
  { key: "phoneNumbers", label: "Phone numbers" },
] as const;
export type BulkField = (typeof BULK_FIELDS)[number]["key"];

export const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
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
export type DayRow = { day: Day; open: string; close: string; closed: boolean };
export const defaultWeek = (): DayRow[] =>
  DAYS.map((day) => ({ day, open: "09:00", close: "17:00", closed: day === "SATURDAY" || day === "SUNDAY" }));
export function changedDays(week: DayRow[], initial = defaultWeek()): Day[] {
  return week.filter((r, i) => JSON.stringify(r) !== JSON.stringify(initial[i])).map((r) => r.day);
}

export type BulkForm = {
  use: Record<BulkField, boolean>;
  week: DayRow[];
  description: string;
  website: string;
  title: string;
  /**
   * "add" appends `add` to each location's additional categories (the primary and the rest are kept);
   * "replace" sets `primary` and `additional` as the whole list.
   */
  categories: { mode: "add" | "replace"; add: string[]; primary: string; additional: string[] };
  /** "add" appends to each location's current list; "replace" overwrites it (loses prices, other categories, Google-list services). */
  services: { lines: string; category: string; mode: "add" | "replace" };
  area: { type: "" | "CUSTOMER_LOCATION_ONLY" | "CUSTOMER_AND_BUSINESS_LOCATION"; places: string };
  openingDate: string;
  phones: { primary: string; more: string };
};
export const emptyForm = (): BulkForm => ({
  use: Object.fromEntries(BULK_FIELDS.map((f) => [f.key, false])) as Record<BulkField, boolean>,
  week: defaultWeek(),
  description: "",
  website: "",
  title: "",
  categories: { mode: "add", add: [], primary: "", additional: [] },
  services: { lines: "", category: "", mode: "add" },
  area: { type: "", places: "" },
  openingDate: "",
  phones: { primary: "", more: "" },
});
export const anyField = (f: BulkForm) => Object.values(f.use).some(Boolean);

/** Built by the component with profile-forms.tsx's shared editors (specialFromRows, attributeFromRow). */
export type Built = { specialHours: unknown; attributes: Record<string, unknown> };

const TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const tod = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return { hours: h ?? 0, minutes: m ?? 0 };
};
const list = (s: string, sep: RegExp) =>
  s
    .split(sep)
    .map((x) => x.trim())
    .filter(Boolean);

/** The category the new services go in: the picked one, else the primary of a categories Replace in the same edit. */
export const serviceCategory = (f: BulkForm) =>
  f.services.category.trim() || (f.use.categories && f.categories.mode === "replace" ? f.categories.primary.trim() : "");

const typedServices = (f: BulkForm) => {
  const category = serviceCategory(f);
  return list(f.services.lines, /\n/).map((displayName) => ({
    freeFormServiceItem: { category, label: { displayName } },
  }));
};

/** The typed services to append to each location's current list (core's `addServiceItems`); add mode only. */
export function buildAddServices(f: BulkForm) {
  return f.use.serviceItems && f.services.mode === "add" ? typedServices(f) : undefined;
}

/** The names of the services being added, in the order core's `serviceAdd` indexes them. */
export const addServiceNames = (f: BulkForm) =>
  (buildAddServices(f) ?? []).map((i) => i.freeFormServiceItem.label.displayName);

/** The categories to append to each location's own (core's `addCategories`); add mode only. */
export function buildAddCategories(f: BulkForm) {
  return f.use.categories && f.categories.mode === "add" ? f.categories.add.map((name) => ({ name })) : undefined;
}

/**
 * Add-mode services are only sent to locations that have the service's category (core's
 * `skipUnofferedServices`, as in Copy services); the others are flagged in the preview.
 */
export const buildSkipUnoffered = (f: BulkForm) => (buildAddServices(f) ? true : undefined);

/** Only ticked fields, each in core's `profileFieldsInput` shape. Core diffs per location. */
export function buildFields(f: BulkForm, built: Built): Record<string, unknown> {
  const u = f.use;
  const out: Record<string, unknown> = {};
  if (u.regularHours) {
    const periods = f.week
      .filter((r) => !r.closed)
      .map((r) => ({ openDay: r.day, openTime: tod(r.open), closeDay: r.day, closeTime: tod(r.close) }));
    out.regularHours = periods.length > 0 ? { periods } : null;
  }
  if (u.specialHours) out.specialHours = built.specialHours;
  if (u.attributes && Object.keys(built.attributes).length > 0) out.attributes = built.attributes;
  if (u.description) out.description = f.description.trim();
  if (u.websiteUri) out.websiteUri = f.website.trim() || null;
  if (u.title) out.title = f.title.trim();
  if (u.categories && f.categories.mode === "replace") {
    out.categories = {
      primaryCategory: { name: f.categories.primary.trim() },
      additionalCategories: f.categories.additional.map((name) => ({ name })),
    };
  }
  if (u.serviceItems && f.services.mode === "replace") out.serviceItems = typedServices(f);
  if (u.serviceArea) {
    out.serviceArea = f.area.type
      ? {
          businessType: f.area.type,
          places: {
            placeInfos: list(f.area.places, /\n/).map((l) => {
              const [placeName = "", placeId = ""] = l.split("|").map((x) => x.trim());
              return { placeName, placeId };
            }),
          },
        }
      : null;
  }
  if (u.openingDate) {
    const t = f.openingDate.trim();
    const [year, month, day] = t.split("-").map(Number);
    out.openingDate = t ? { year, month, day } : null;
  }
  if (u.phoneNumbers) {
    out.phoneNumbers = { primaryPhone: f.phones.primary.trim(), additionalPhones: list(f.phones.more, /,/) };
  }
  return out;
}

export type Problem = {
  /** What the input is called, so the component can show it once that input has been touched. */
  key: "regularHours" | "description" | "title" | "categories" | "openingDate" | "services" | "serviceCategory" | "phoneNumbers";
  message: string;
};

/** Form mistakes we can name before asking core (core still checks everything). */
export function formProblemList(f: BulkForm): Problem[] {
  const p: Problem[] = [];
  const add = (key: Problem["key"], message: string) => p.push({ key, message });
  if (f.use.regularHours) {
    for (const r of f.week) {
      if (!r.closed && (!TIME.test(r.open) || !TIME.test(r.close))) {
        add("regularHours", `${DAY_LABEL[r.day]}: use HH:MM, for example 09:00`);
      }
    }
  }
  if (f.use.description && !f.description.trim()) add("description", "Description: cannot be empty");
  if (f.use.title && !f.title.trim()) add("title", "Title: cannot be empty");
  if (f.use.categories) {
    if (f.categories.mode === "add" && f.categories.add.length === 0) {
      add("categories", "Categories: choose at least one category to add");
    }
    if (f.categories.mode === "replace" && !f.categories.primary.trim()) {
      add("categories", "Categories: the primary category is required");
    }
  }
  if (f.use.openingDate && f.openingDate.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(f.openingDate.trim())) {
    add("openingDate", "Opening date: use YYYY-MM-DD");
  }
  if (f.use.serviceItems && f.services.mode === "add") {
    if (typedServices(f).length === 0) add("services", "Services: type at least one service to add");
    else if (!serviceCategory(f)) add("serviceCategory", "Services: choose the category for the new services");
  }
  if (f.use.phoneNumbers && !f.phones.primary.trim()) add("phoneNumbers", "Phone numbers: the primary phone is required");
  return p;
}
export const formProblems = (f: BulkForm): string[] => formProblemList(f).map((p) => p.message);

// ------------------------------------------------------------------ preview

/**
 * What replacing this location's services would remove, from the preview's `current` snapshot.
 * Null when it has none. "Other categories" are the free-form categories other than `newCategory`.
 */
export function replaceWarning(name: string, current: unknown, newCategory: string): string | null {
  const items = (current as { fields?: { serviceItems?: Record<string, unknown>[] | null } } | null)?.fields?.serviceItems;
  if (!items || items.length === 0) return null;
  const free = items.map((i) => i.freeFormServiceItem as { category: string } | undefined);
  const others = new Set(free.flatMap((x) => (x && x.category !== newCategory ? [x.category] : [])));
  const structured = items.filter((i) => i.structuredServiceItem).length;
  const parts = [
    `${items.length} ${items.length === 1 ? "service" : "services"}`,
    `${items.filter((i) => i.price).length} with prices`,
    `${others.size} other ${others.size === 1 ? "category" : "categories"}`,
    ...(structured ? [`${structured} from Google's list`] : []),
  ];
  return `${name}: ${parts.join(", ")} will be removed`;
}

const FIELD_LABEL: Record<string, string> = {
  title: "Title",
  description: "Description",
  categories: "Categories",
  regularHours: "Regular hours",
  specialHours: "Special hours",
  serviceItems: "Services",
  serviceArea: "Service area",
  websiteUri: "Website",
  openingDate: "Opening date",
  phoneNumbers: "Phone numbers",
};
/** "Regular hours, Special hours, 1 attribute". */
export function changesSummary(fields: string[]): string {
  const named = fields.filter((f) => !f.startsWith("attributes/")).map((f) => FIELD_LABEL[f] ?? profileFieldLabel(f));
  const n = fields.length - named.length;
  if (n > 0) named.push(`${n} ${n === 1 ? "attribute" : "attributes"}`);
  return named.join(", ");
}

export type PreviewLike = {
  locationId: string;
  locationName: string;
  error: string | null;
  changes: { field: string; after?: unknown }[];
  updateMask: string[];
  attributeMask: string[];
  noChange: boolean;
  guardrail: { ok: boolean; violations: { severity: "block" | "warn" }[] } | null;
};
export type PreviewRow = {
  locationId: string;
  name: string;
  changes: string;
  mask: string;
  check: string;
  result: "Ready" | "no change" | "error" | "blocked";
  tone: Tone;
  error: string | null;
};

export function previewRow(p: PreviewLike): PreviewRow {
  const base = { locationId: p.locationId, name: p.locationName, error: null as string | null };
  if (p.error) return { ...base, changes: "", mask: "·", check: "·", result: "error", tone: "bad", error: p.error };
  if (p.noChange) {
    return { ...base, changes: "Already matches Google", mask: "·", check: "·", result: "no change", tone: "neutral" };
  }
  const v = p.guardrail?.violations ?? [];
  const blocks = v.filter((x) => x.severity === "block").length;
  const warns = v.length - blocks;
  const check =
    v.length === 0
      ? "No guardrail violations."
      : [blocks ? `${blocks} blocking` : null, warns ? `${warns} ${warns === 1 ? "warning" : "warnings"}` : null]
          .filter(Boolean)
          .join(", ");
  return {
    ...base,
    changes: changesSummary(p.changes.map((c) => c.field)),
    mask: [...p.updateMask, ...p.attributeMask].join(", "),
    check,
    result: blocks ? "blocked" : "Ready",
    tone: blocks ? "bad" : "good",
  };
}

/** The categories a location ends up with (primary first), from a preview change's `after`; null when it does not change them. */
export function categoriesAfter(changes: { field: string; after?: unknown }[]): string[] | null {
  const after = changes.find((c) => c.field === "categories")?.after as
    | { primaryCategory?: { name?: string }; additionalCategories?: { name?: string }[] }
    | null
    | undefined;
  if (!after) return null;
  return [after.primaryCategory?.name, ...(after.additionalCategories ?? []).map((x) => x.name)].filter((n): n is string => Boolean(n));
}

/** At least one readable location changes and none is blocked. Unreadable ones are left out. */
export function canPropose(preview: PreviewLike[] | null): boolean {
  if (!preview) return false;
  const readable = preview.filter((p) => !p.error);
  return readable.some((p) => !p.noChange) && readable.every((p) => !p.guardrail || p.guardrail.ok);
}

// ------------------------------------------------------------------ change set history

export type SetLike = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  approvedByName: string | null;
  rejectReason: string | null;
  fields: { fields: Record<string, unknown>; attributes: Record<string, unknown> };
  targets: { locationName: string; status: string; error: string | null; appliedAt: string | null; changes: { field: string }[] }[];
};
const counted = (s: SetLike) => s.targets.filter((t) => t.status !== "no_change");

export const setTitle = (s: SetLike) =>
  changesSummary([...Object.keys(s.fields.fields), ...Object.keys(s.fields.attributes)]);

export function setMeta(s: SetLike, tf: TimeFormat): string {
  const n = counted(s).length;
  const locs = `${n} ${n === 1 ? "location" : "locations"}`;
  if (s.status === "approved") {
    return `${locs} | proposed ${tf.date(s.createdAt)}, approved by ${s.approvedByName ?? "a team member"}`;
  }
  if (s.status === "applied" || s.status === "partially_applied" || s.status === "failed") {
    const at = counted(s)
      .map((t) => t.appliedAt)
      .filter((x): x is string => Boolean(x))
      .sort()
      .pop();
    return `${locs} | applied ${tf.dateTime(at ?? s.updatedAt)}`;
  }
  return `${locs} | proposed ${tf.dateTime(s.createdAt)}`;
}

/** There is no rejected status: a rejection is a cancelled set with a reason. */
export function endNote(s: SetLike): string | null {
  if (s.status === "cancelled") {
    return s.rejectReason
      ? `Reject reason: ${s.rejectReason}`
      : "Someone cancelled it before it was applied. Nothing was sent to Google.";
  }
  if (s.status === "blocked") return "A guardrail blocked it at proposal, so it never reached approval.";
  return null;
}

export const showsResults = (status: string) =>
  status === "applied" || status === "partially_applied" || status === "failed";

export function resultRows(s: SetLike) {
  return counted(s).map((t) => ({
    location: t.locationName,
    status: t.status,
    code: t.error,
    reason: t.error ? failureLabel(t.error) : "",
    fields: profileFieldsLabel(t.changes.map((c) => c.field)),
  }));
}
