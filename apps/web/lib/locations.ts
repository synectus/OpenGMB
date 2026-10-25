import { pageWindow } from "./health";
import { statusWords } from "./labels";
// Pure logic for the /locations views. No React, no core runtime imports: client components use it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string | undefined): v is string => v !== undefined && UUID.test(v);

export type LocationView = "list" | "health" | "alerts" | "bulk-edit";

const VIEWS: { key: LocationView; label: string; path: string }[] = [
  { key: "list", label: "List", path: "/locations" },
  { key: "health", label: "Health", path: "/locations/health" },
  { key: "alerts", label: "Alerts", path: "/locations/alerts" },
  { key: "bulk-edit", label: "Bulk edit", path: "/locations/bulk-edit" },
];

/** Views whose page exists: a tab never 404s. */
export const SHIPPED_VIEWS: ReadonlySet<LocationView> = new Set<LocationView>(["list", "health", "alerts", "bulk-edit"]);

export function viewTabs(
  current: LocationView,
  o: { ws?: string; alerts?: number | null },
): { key: LocationView; href: string; label: string; current: boolean }[] {
  const qs = o.ws ? `?ws=${o.ws}` : "";
  return VIEWS.filter((v) => SHIPPED_VIEWS.has(v.key)).map((v) => ({
    key: v.key,
    href: `${v.path}${qs}`,
    label: v.key === "alerts" && o.alerts != null ? `${v.label} (${o.alerts})` : v.label,
    current: v.key === current,
  }));
}

export type StatusFilter = "all" | "active" | "inactive" | "relink";
export const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "inactive", label: "Inactive" },
  { key: "relink", label: "Needs re-link" },
];
export function parseStatusFilter(v: string | undefined): StatusFilter {
  return STATUS_FILTERS.some((f) => f.key === v) ? (v as StatusFilter) : "all";
}

/** Locations on one page of the list. Each row is a link, a badge row and a stats cell: 2 MB of HTML at 500 locations in one page (U8). */
export const LOCATIONS_PAGE_SIZE = 50;

/** One page of the (already filtered) rows; a page past the end falls back to the last page. */
export function locationsPage<T>(rows: T[], page: number) {
  const w = pageWindow(page, LOCATIONS_PAGE_SIZE, rows.length);
  return { rows: rows.slice(w.offset, w.offset + LOCATIONS_PAGE_SIZE), window: w };
}

export function locationsHref(o: { ws?: string; status?: StatusFilter; group?: string; q?: string; page?: number }): string {
  const p = new URLSearchParams();
  if (o.ws) p.set("ws", o.ws);
  if (o.status && o.status !== "all") p.set("status", o.status);
  if (o.group) p.set("group", o.group);
  if (o.q?.trim()) p.set("q", o.q.trim());
  if (o.page && o.page > 1) p.set("page", String(o.page));
  const qs = p.toString();
  return qs ? `/locations?${qs}` : "/locations";
}

/** Where a location opens: its Overview. */
export const locationHref = (id: string) => `/locations/${id}`;

export type ListRow = {
  id: string;
  name: string;
  addressSummary: string | null;
  phone: string | null;
  status: "active" | "inactive";
  needsRelink: boolean;
  groups: { id: string; name: string }[];
};

const matches: Record<StatusFilter, (r: ListRow) => boolean> = {
  all: () => true,
  active: (r) => r.status === "active",
  inactive: (r) => r.status === "inactive",
  relink: (r) => r.needsRelink,
};

export function statusCounts(rows: ListRow[]): Record<StatusFilter, number> {
  return {
    all: rows.length,
    active: rows.filter(matches.active).length,
    inactive: rows.filter(matches.inactive).length,
    relink: rows.filter(matches.relink).length,
  };
}

export function filterLocations<T extends ListRow>(
  rows: T[],
  f: { status?: StatusFilter; group?: string; q?: string },
): T[] {
  const q = f.q?.trim().toLowerCase() ?? "";
  return rows.filter(
    (r) =>
      matches[f.status ?? "all"](r) &&
      (!f.group || r.groups.some((g) => g.id === f.group)) &&
      (!q || `${r.name} ${r.addressSummary ?? ""}`.toLowerCase().includes(q)),
  );
}

export const ratingText = (avg: number | null) => (avg === null ? "–" : avg.toFixed(1));
export const reviewCountText = (n: number) =>
  n === 0 ? "No reviews" : `${n} ${n === 1 ? "review" : "reviews"}`;

export const loadedLine = (account: string, n: number) =>
  `${account} · ${n} ${n === 1 ? "location" : "locations"} loaded`;

export function pickerNote(l: {
  alreadyImported: boolean;
  needsRelink: boolean;
  importedWorkspace: { name: string } | null;
}): string {
  if (!l.alreadyImported) return "";
  if (l.needsRelink) return ` - imported in ${l.importedWorkspace?.name}, needs re-link`;
  return l.importedWorkspace
    ? ` - already imported in ${l.importedWorkspace.name}`
    : " - active in another organization";
}

export function selectionNote(count: number, max: number): { text: string; over: boolean } {
  return count > max
    ? { text: `Pick up to ${max} locations at a time.`, over: true }
    : { text: `${count} selected. Up to ${max} at a time.`, over: false };
}

export type ImportResultCode =
  | "imported"
  | "already_imported"
  | "relinked"
  | "exists_inactive"
  | "conflict"
  | "not_found";
export const importResultLabel = (r: ImportResultCode | string) =>
  r === "relinked" ? "Re-linked to this Google connection" : statusWords(r);
export function importResultTone(r: ImportResultCode | string): "good" | "warn" | "bad" | "neutral" {
  if (r === "relinked") return "good";
  if (r === "exists_inactive") return "warn";
  if (r === "conflict" || r === "not_found") return "bad";
  return "neutral";
}
/** Import and re-link queue a first review sync and a performance backfill (locations/import.ts). */
export function queuedNote(titles: string[]): string | null {
  if (titles.length === 0) return null;
  return titles.length === 1
    ? `${titles[0]}: a review sync and a performance backfill are queued.`
    : `${titles.join(", ")}: a review sync and a performance backfill are queued for each.`;
}

export function groupSummary(memberIds: string[], locations: { id: string; name: string }[]): string {
  const names = locations.filter((l) => memberIds.includes(l.id)).map((l) => l.name);
  if (names.length === 0) return "No locations";
  return `${names.length} ${names.length === 1 ? "location" : "locations"} · ${names.join(", ")}`;
}

type Result =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };
/** What happened after Activate or Deactivate: null when it worked, a key for the two known refusals, else the server's own text. */
export function setStatusOutcome(r: Result): "conflict" | "not_found" | { raw: string } | null {
  if (!r.ok) return { raw: `${r.error.code}: ${r.error.message}` };
  const res = (r.data as { results: { result: string }[] }).results[0]?.result;
  if (res === "conflict" || res === "not_found") return res;
  return null;
}
/** The inline message after Activate or Deactivate, or null when it worked. */
export function setStatusMessage(r: Result): string | null {
  const o = setStatusOutcome(r);
  if (o === null) return null;
  if (o === "conflict")
    return "That Google location is already active somewhere else, so it cannot be activated here.";
  if (o === "not_found") return "NOT_FOUND: Location not found";
  return o.raw;
}
