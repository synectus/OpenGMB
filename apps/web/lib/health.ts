// Pure logic for the Health tab and the org Health view. Client-safe: no core runtime imports.
import type { TimeFormat } from "./time-format";

export type Importance = "necessary" | "important" | "nice";
export type CheckRow = {
  id: string;
  title: string;
  importance: Importance;
  status: "pass" | "fail" | "unknown" | "skipped";
  detail: string;
  fix: { label: string; href: string } | null;
  skipped: { byName: string | null; at: string } | null;
};

export type Show = "all" | "failing" | "skipped";
export const SHOW_PILLS: { key: Show; label: string }[] = [
  { key: "all", label: "All" },
  { key: "failing", label: "Failing" },
  { key: "skipped", label: "Skipped" },
];
export const parseShow = (v: string | undefined): Show =>
  v === "failing" || v === "skipped" ? v : "all";
export const showCounts = (checks: CheckRow[]) => ({
  all: checks.length,
  failing: checks.filter((c) => c.status === "fail").length,
  skipped: checks.filter((c) => c.status === "skipped").length,
});
export const visibleChecks = (checks: CheckRow[], show: Show) =>
  show === "all" ? checks : checks.filter((c) => c.status === (show === "failing" ? "fail" : "skipped"));

export const GROUPS: { importance: Importance; title: string }[] = [
  { importance: "necessary", title: "Necessary" },
  { importance: "important", title: "Important" },
  { importance: "nice", title: "Nice to have" },
];
export const IMPORTANCE_LABEL: Record<Importance, string> = {
  necessary: "necessary",
  important: "important",
  nice: "nice to have",
};
export const groupTitle = (title: string, n: number) => `${title} (${n})`;

export const scoreLine = (s: { passed: number; total: number }, failingNecessary: number) =>
  `${s.passed} of ${s.total} checks pass${failingNecessary > 0 ? ` · ${failingNecessary} necessary failing` : ""}`;
export const scoreTone = (percent: number): "good" | "warn" | "bad" =>
  percent >= 80 ? "good" : percent >= 50 ? "warn" : "bad";

export const skippedLine = (s: { byName: string | null; at: string }, tf: TimeFormat, ws?: string) =>
  `Skipped by ${s.byName ?? "a team member"} on ${tf.date(s.at, ws)} · left out of the score`;

export const thresholdsNote = (c: {
  minPhotos: number;
  recentPhotoDays: number;
  recentPostDays: number;
  minAverageRating: number;
}) =>
  `Thresholds are Synectus's own rules of thumb, not Google limits: ${c.minPhotos} photos, a photo within ${c.recentPhotoDays} days, a post within ${c.recentPostDays} days, an average of ${c.minAverageRating.toFixed(1)} or higher.`;

const plural = (n: number) => `${n} ${n === 1 ? "location" : "locations"}`;

export function averagePercent(locs: { score: { percent: number } }[]): number | null {
  return locs.length ? Math.round(locs.reduce((n, l) => n + l.score.percent, 0) / locs.length) : null;
}
export function summaryLine(checked: number, inScope: number, avg: number | null): string {
  return `${checked} of ${plural(inScope)} checked${avg === null ? "" : ` · average ${avg}%`}`;
}

/** The summary lists failing checks necessary first already; the row shows three. */
export const topFailing = <T>(failing: T[], n = 3) => failing.slice(0, n);

export function commonFailing(
  locs: { failing: { title: string }[] }[],
  max = 4,
): { title: string; count: string }[] {
  const n = new Map<string, number>();
  for (const l of locs) for (const f of l.failing) n.set(f.title, (n.get(f.title) ?? 0) + 1);
  return [...n.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([title, c]) => ({ title, count: plural(c) }));
}

function names(list: string[], what: string): string {
  if (list.length > 3) return `${list.length} locations are ${what}`;
  const joined = list.length === 1 ? list[0]! : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  return `${joined} ${list.length === 1 ? "is" : "are"} ${what}`;
}
/** Why some locations in scope are not in the summary (it checks active, Google-linked ones only). */
export function exclusionNote(
  locs: { name: string; status: "active" | "inactive"; needsRelink: boolean; googleLocationId: string | null }[],
): string | null {
  const inactive = locs.filter((l) => l.status === "inactive").map((l) => l.name);
  const unlinked = locs
    .filter((l) => l.status === "active" && (l.needsRelink || l.googleLocationId === null))
    .map((l) => l.name);
  const parts = [
    unlinked.length ? names(unlinked, "not linked to Google") : null,
    inactive.length ? names(inactive, "inactive") : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  const one = unlinked.length + inactive.length === 1;
  return `${parts.join(" and ")}, so ${one ? "it is" : "they are"} not checked.`;
}

export const parsePage = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : 1;
};

/** Which slice of `total` locations a page covers; a page past the end falls back to the last page. */
export function pageWindow(page: number, size: number, total: number) {
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(page, pages);
  const offset = (p - 1) * size;
  return {
    page: p,
    offset,
    from: total === 0 ? 0 : offset + 1,
    to: Math.min(offset + size, total),
    pages,
    total,
    hasPrev: p > 1,
    hasNext: p < pages,
  };
}

export const pageNote = (w: ReturnType<typeof pageWindow>, size: number) =>
  w.pages === 1
    ? `${plural(w.total)}, worst score first.`
    : `Locations ${w.from} to ${w.to} of ${w.total}, worst score first within this page. Each page checks ${size} locations, by name.`;
