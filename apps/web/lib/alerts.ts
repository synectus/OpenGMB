// Pure logic for the org-wide Alerts inbox (/locations/alerts). Client-safe.
import type { TimeFormat } from "./time-format";
import { attributeLabel, humanise } from "./labels";
import { parseStatus, revertLine, type ChangeData, type StatusFilter } from "./changes";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | undefined) => (v && UUID.test(v) ? v : null);

/** The board's Field options, each a set of profile field names (core matches any of them). */
export const FIELD_GROUPS = {
  hours: { label: "Hours", fields: ["regularHours", "specialHours"] },
  website: { label: "Website", fields: ["websiteUri"] },
  title: { label: "Title", fields: ["title"] },
  categories: { label: "Categories", fields: ["categories"] },
  phone: { label: "Phone", fields: ["phoneNumbers"] },
  description: { label: "Description", fields: ["description"] },
} as const;
export type FieldGroup = keyof typeof FIELD_GROUPS;
export const SOURCES = { snapshot: "Nightly snapshot", google: "Google suggestion" } as const;
export type Source = keyof typeof SOURCES;

export type AlertFilters = {
  status: StatusFilter;
  source: Source | "all";
  field: FieldGroup | "all";
  loc: string | null;
  group: string | null;
  ws: string | null;
  change: string | null;
};

export function parseAlertFilters(sp: Record<string, string | undefined>): AlertFilters {
  return {
    status: parseStatus(sp.status),
    source: sp.source && sp.source in SOURCES ? (sp.source as Source) : "all",
    field: sp.field && sp.field in FIELD_GROUPS ? (sp.field as FieldGroup) : "all",
    loc: uuidOrNull(sp.loc),
    group: uuidOrNull(sp.group),
    ws: uuidOrNull(sp.ws),
    change: uuidOrNull(sp.change),
  };
}

/** Defaults are left out; a patch that does not set the selection clears the selected change. */
export function alertsHref(f: AlertFilters, patch: Partial<AlertFilters> = {}): string {
  const next = { ...f, ...(Object.keys(patch).length === 0 || "change" in patch ? {} : { change: null }), ...patch };
  const p = new URLSearchParams();
  if (next.status !== "open") p.set("status", next.status);
  if (next.source !== "all") p.set("source", next.source);
  if (next.field !== "all") p.set("field", next.field);
  if (next.loc) p.set("loc", next.loc);
  if (next.group) p.set("group", next.group);
  if (next.ws) p.set("ws", next.ws);
  if (next.change) p.set("change", next.change);
  const qs = p.toString();
  return qs ? `/locations/alerts?${qs}` : "/locations/alerts";
}

export const LIMIT = 200;
/** Input for profile.changes.list. */
export function listInput(f: AlertFilters, over: { status?: StatusFilter; limit?: number } = {}) {
  const status = over.status ?? f.status;
  return {
    ...(status === "all" ? {} : { status }),
    ...(f.field === "all" ? {} : { fields: [...FIELD_GROUPS[f.field].fields] }),
    ...(f.source === "all" ? {} : { googleSuggested: f.source === "google" }),
    ...(f.loc ? { locationId: f.loc } : {}),
    ...(f.group ? { groupId: f.group } : {}),
    ...(f.ws ? { workspaceId: f.ws } : {}),
    limit: over.limit ?? LIMIT,
  };
}
export const hasNarrowing = (f: AlertFilters) =>
  f.source !== "all" || f.field !== "all" || Boolean(f.loc || f.group || f.ws);

const LABEL: Record<string, string> = {
  regularHours: "Hours",
  specialHours: "Special hours",
  websiteUri: "Website",
  title: "Title",
  description: "Description",
  categories: "Categories",
  phoneNumbers: "Phone",
  serviceItems: "Services",
  serviceArea: "Service area",
  openingDate: "Opening date",
  storeCode: "Store code",
  storefrontAddress: "Address",
};
const fieldsText = (paths: string[]) =>
  paths
    .map((p) => (p.startsWith("attributes/") ? `Attribute ${attributeLabel(p).toLowerCase()}` : (LABEL[p] ?? humanise(p))))
    .join(", ");
/** "Hours, Website changed". */
export const changeSummary = (paths: string[]) => `${fieldsText(paths)} changed`;
export const sourceLabel = (c: Pick<ChangeData, "googleSuggested">) =>
  c.googleSuggested ? SOURCES.google : SOURCES.snapshot;
export const foundCell = (iso: string, tf: TimeFormat, ws?: string) => tf.dateTime(iso, ws);

/** Bulk Accept and Dismiss apply only to rows where you may do both. */
export const selectableIds = (list: ChangeData[]) =>
  list.filter((c) => c.can.accept && c.can.dismiss).map((c) => c.id);
export function toggleAllSelected(selected: string[], list: ChangeData[]): string[] {
  const all = selectableIds(list);
  return all.length > 0 && all.every((id) => selected.includes(id)) ? [] : all;
}

type Result = { ok: true } | { ok: false; error: { code: string; message: string } };
/** One after another, never in parallel; a failure does not stop the rest. */
export async function runSequentially(ids: string[], fn: (id: string) => Promise<Result>) {
  const done: string[] = [];
  const errors: { id: string; message: string }[] = [];
  for (const id of ids) {
    try {
      const r = await fn(id);
      if (r.ok) done.push(id);
      else errors.push({ id, message: `${r.error.code}: ${r.error.message}` });
    } catch {
      errors.push({ id, message: "INTERNAL: request failed" });
    }
  }
  return { done, errors };
}

/** Resolved changes, newest decision first. */
export function activity(list: ChangeData[], o: { writesOff: boolean }, tf: TimeFormat, max = 10) {
  return list
    .filter((c) => c.status !== "open" && c.resolvedAt)
    .sort((a, b) => b.resolvedAt!.localeCompare(a.resolvedAt!))
    .slice(0, max)
    .map((c) => ({
      id: c.id,
      time: tf.dateTime(c.resolvedAt!, c.workspaceId),
      text: `${c.revertChangeSetSurface === "worker" ? "Auto-revert" : (c.resolvedByName ?? "A team member")} ${c.status} ${fieldsText(c.fieldPaths)} at ${c.locationName}`,
      note: c.revertChangeSetStatus
        ? `${revertLine(c.revertChangeSetStatus)}${o.writesOff && c.revertChangeSetStatus === "approved" ? ", Apply fails while writes are off" : ""}`
        : null,
    }));
}
