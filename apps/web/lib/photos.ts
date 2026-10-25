// Pure logic for the Photos tab: category pills, sort, labels, card buttons, the operation line,
// file checks with the canvas copy, and the upload queue. Client-safe: no runtime import from core;
// the page passes MEDIA_LIMITS numbers in as `Limits`.
import { failureLabel } from "./failure-labels";
import { enumLabel, isMissingTimestamp, statusLabel } from "./labels";
import type { TimeFormat } from "./time-format";

export type PhotoLike = {
  name: string;
  category: string | null;
  createTime: string | null;
  widthPixels: number | null;
  heightPixels: number | null;
  sourceUrl: string | null;
  googleUrl: string | null;
};
export type OpLike = {
  id: string;
  kind: "add" | "update" | "delete";
  status: "scheduled" | "pending" | "applied" | "failed" | "cancelled";
  error: string | null;
  payload: Record<string, unknown>;
  /** When a scheduled op is due (an instant). */
  scheduledFor?: string | null;
};
export type Limits = {
  minBytes: number;
  maxBytes: number;
  minShortEdgePx: number;
  /** Categories that skip the minimum bytes and pixels (Google: COVER and PROFILE). */
  minimumsExempt: readonly string[];
};

/** Pill labels in Google's category order (MEDIA_LIMITS.categories); NONE = Google gave no category. */
const PILL_LABEL: Record<string, string> = {
  COVER: "Cover",
  PROFILE: "Logo",
  EXTERIOR: "Exterior",
  INTERIOR: "Interior",
  PRODUCT: "Product",
  AT_WORK: "At work",
  FOOD_AND_DRINK: "Food and drink",
  MENU: "Menu",
  COMMON_AREA: "Common area",
  ROOMS: "Rooms",
  TEAMS: "Teams",
  ADDITIONAL: "Additional",
  NONE: "No category",
};
const ORDER = Object.keys(PILL_LABEL);
const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);

export const categoryChip = (c: string | null) => (c === null ? "No category" : enumLabel(c));
export const filterKey = (c: string | null) => c ?? "NONE";

export type Pill = { key: string; label: string };
export function categoryPills(items: PhotoLike[]): Pill[] {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(filterKey(i.category), (counts.get(filterKey(i.category)) ?? 0) + 1);
  const keys = [...counts.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [
    { key: "all", label: `All (${items.length})` },
    ...keys.map((k) => ({ key: k, label: `${PILL_LABEL[k] ?? enumLabel(k)} (${counts.get(k)})` })),
  ];
}
export const filterPhotos = <T extends PhotoLike>(items: T[], key: string): T[] =>
  key === "all" ? items : items.filter((i) => filterKey(i.category) === key);

export type SortOrder = "newest" | "oldest";
/** By createTime; photos without one go last either way; equal times keep their order. */
export function sortPhotos<T extends PhotoLike>(items: T[], order: SortOrder): T[] {
  return items
    .map((item, i) => ({ item, i, t: item.createTime ? Date.parse(item.createTime) : null }))
    .sort((a, b) => {
      if (a.t === b.t) return a.i - b.i;
      if (a.t === null) return 1;
      if (b.t === null) return -1;
      return order === "newest" ? b.t - a.t : a.t - b.t;
    })
    .map((w) => w.item);
}

export const sizeLabel = (w: number | null, h: number | null) => (w && h ? `${w} x ${h}` : "");
export const addedLabel = (t: string | null, tf: TimeFormat, ws?: string) => (isMissingTimestamp(t) ? "" : `Added ${tf.date(t!, ws)}`);

/** Card buttons. Cover and logo are replaced by adding a new one, never deleted here (canvas). */
export function photoActions(p: PhotoLike) {
  const source = Boolean(p.sourceUrl ?? p.googleUrl);
  return {
    cover: source && p.category !== "COVER",
    logo: source && p.category !== "PROFILE",
    remove: p.category !== "COVER" && p.category !== "PROFILE",
  };
}

/** "Adding exterior photo: queued"; pending reads queued (the worker has it); a failure gives its plain reason. */
export function opText(op: OpLike, items: PhotoLike[]): string {
  const cat =
    op.kind === "delete"
      ? items.find((i) => i.name === op.payload.mediaName)?.category
      : (op.payload.category as string | null | undefined);
  const what = cat ? `${enumLabel(cat).toLowerCase()} photo` : "photo";
  const status = statusLabel(op.status === "pending" ? "queued" : op.status).toLowerCase();
  return `${op.kind === "delete" ? "Remove" : "Add"} ${what}: ${status}${op.error ? ` (${failureLabel(op.error)})` : ""}`;
}
export const opTone = (op: OpLike) =>
  op.status === "failed" ? "bad" : op.status === "pending" || op.status === "scheduled" ? "info" : "good";
export const openOps = <T extends OpLike>(ops: T[]) =>
  ops.filter((o) => o.status !== "applied" && o.status !== "cancelled");

/**
 * What polling an operation should do next. `pending` is the only state still in motion; a
 * `scheduled` op waits for its time (possibly days) so polling stops without calling it applied,
 * and `cancelled` is terminal but not a success.
 */
export type Settlement = "working" | "applied" | "scheduled" | "cancelled" | "failed";
export function opSettlement(op: { status: OpLike["status"] } | undefined): Settlement {
  if (!op) return "working";
  switch (op.status) {
    case "pending":
      return "working";
    case "failed":
      return "failed";
    case "scheduled":
      return "scheduled";
    case "cancelled":
      return "cancelled";
    case "applied":
      return "applied";
  }
}

/** `code: label` when the code has a human label, else the code alone. */
export function failureLine(code: string): string {
  const label = failureLabel(code);
  return label === code ? code : `${code}: ${label}`;
}

const MB = 1024 * 1024;
/** "5 MB", "6.2 MB", "340 KB". */
export const fileSize = (bytes: number) =>
  bytes >= MB ? `${+(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const helpText = (l: Limits) =>
  `JPG or PNG, ${fileSize(l.minBytes)} to ${fileSize(l.maxBytes)}, at least ${l.minShortEdgePx} px on the short edge. Cover and logo replace the current one and skip the size minimums.`;

type FileFacts = { name: string; type: string; size: number };
const isHeic = (f: FileFacts) => /heic|heif/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);

/** A file problem as a message key (locationHub.upload.problem.*) plus its values, for translated rendering. */
export type FileProblem = { key: "heic" | "type" | "tooBig" | "tooSmall" | "shortEdge"; values: Record<string, string | number> };

/**
 * The friendly pre-check (core is the real gate). `shortEdge` is null when the browser could not
 * decode the image; the server reads the header and decides.
 */
export function fileProblemParts(
  f: FileFacts,
  category: string,
  l: Limits,
  shortEdge: number | null,
): FileProblem | null {
  if (isHeic(f)) return { key: "heic", values: {} };
  const okType =
    f.type === "image/jpeg" ||
    f.type === "image/png" ||
    (f.type === "" && /\.(jpe?g|png)$/i.test(f.name));
  if (!okType) return { key: "type", values: {} };
  if (f.size > l.maxBytes) return { key: "tooBig", values: { size: fileSize(f.size), limit: fileSize(l.maxBytes) } };
  if (l.minimumsExempt.includes(category)) return null;
  if (f.size < l.minBytes) return { key: "tooSmall", values: { size: fileSize(f.size), min: fileSize(l.minBytes) } };
  if (shortEdge !== null && shortEdge < l.minShortEdgePx) {
    return { key: "shortEdge", values: { edge: shortEdge, min: l.minShortEdgePx } };
  }
  return null;
}

type V = Record<string, string | number>;
const PROBLEM_TEXT: Record<FileProblem["key"], (v: V) => string> = {
  heic: () =>
    "Google does not accept HEIC photos. On an iPhone choose Settings > Camera > Formats > Most Compatible, or pick the photo from your library (it is converted to JPG automatically).",
  type: () => "Only JPG or PNG files can be uploaded.",
  tooBig: (v) => `This file is ${v.size}. The limit is ${v.limit}.`,
  tooSmall: (v) => `This file is ${v.size}. Google needs at least ${v.min}.`,
  shortEdge: (v) => `This image is ${v.edge} px on its short edge. Google needs at least ${v.min} px.`,
};

/** English text of `fileProblemParts` (the lib tests and any untranslated caller). */
export function fileProblem(f: FileFacts, category: string, l: Limits, shortEdge: number | null): string | null {
  const p = fileProblemParts(f, category, l, shortEdge);
  return p ? PROBLEM_TEXT[p.key](p.values) : null;
}

export type Phase = "ready" | "uploading" | "queued" | "scheduled" | "applied" | "failed";

/** One location of a photo sent to several (or later): its own status and reason. */
export type LocationResult = {
  locationId: string;
  status: "scheduled" | "pending" | "applied" | "failed" | "cancelled";
  error: string | null;
};
/** Nothing left to wait for: no result is still queued at Google. */
export const resultsSettled = (r: LocationResult[]) => r.every((x) => x.status !== "pending");
export type QueueItem = FileFacts & {
  key: string;
  shortEdge: number | null;
  category: string;
  phase: Phase;
  percent: number;
  error: string | null;
  /** Per-location results when sent to several locations or scheduled. */
  results?: LocationResult[];
};

export const queueItem = (key: string, f: FileFacts, shortEdge: number | null): QueueItem => ({
  key,
  name: f.name,
  type: f.type,
  size: f.size,
  shortEdge,
  category: "ADDITIONAL",
  phase: "ready",
  percent: 0,
  error: null,
});
export const patchItem = (q: QueueItem[], key: string, p: Partial<QueueItem>) =>
  q.map((i) => (i.key === key ? { ...i, ...p } : i));

const problemOf = (i: QueueItem, l: Limits) => fileProblem(i, i.category, l, i.shortEdge);

/** What "Upload N photos" sends: ready or failed items with no problem. */
export const sendable = (q: QueueItem[], l: Limits) =>
  q.filter((i) => (i.phase === "ready" || i.phase === "failed") && problemOf(i, l) === null);

export const uploadLabel = (n: number) => `Upload ${n} ${n === 1 ? "photo" : "photos"}`;

export function skippedNote(q: QueueItem[], l: Limits): string | null {
  const n = q.filter((i) => i.phase === "ready" && problemOf(i, l) !== null).length;
  if (n === 0) return null;
  return n === 1 ? "The file with a problem is skipped." : `The ${n} files with a problem are skipped.`;
}

export function statusText(i: QueueItem, l: Limits): string {
  switch (i.phase) {
    case "uploading":
      return `${i.percent}%`;
    case "queued":
      return "Queued: Google is processing the photo.";
    case "scheduled":
      return "Scheduled.";
    case "applied":
      return "Done: the photo is on Google.";
    case "failed":
      return `Upload failed: ${i.error ?? "INTERNAL: request failed"}`;
    default:
      return problemOf(i, l) ?? "Ready to upload";
  }
}
