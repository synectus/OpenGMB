// Pure logic for /geogrid (Rank tracking): views, links, money and time text, scan navigation,
// favourites, quick wins. Unit tested; no React.
import { createTranslator } from "next-intl";
import geogrid from "../messages/pages/geogrid";
import geogridCost from "../messages/pages/geogridCost";
import { liveStatus } from "./live-status";

/** A translator for the `geogrid` namespace: the page's `t`, or `enT` (English) when a caller passes none. */
export type Tr = (key: string, values?: Record<string, string | number>) => string;
export const enT: Tr = createTranslator({
  locale: "en",
  messages: { geogrid: geogrid.en },
  namespace: "geogrid",
}) as unknown as Tr;

/** A translator for `geogridCost`: the agency money text, which client viewers never receive. */
export const enTc: Tr = createTranslator({
  locale: "en",
  messages: { geogridCost: geogridCost.en },
  namespace: "geogridCost",
}) as unknown as Tr;

export type View = "trackers" | "keywords" | "competitors" | "new" | "scan" | "usage";
export const VIEWS: { key: View; label: string }[] = [
  { key: "trackers", label: "Trackers" },
  { key: "keywords", label: "Keyword rank" },
  { key: "competitors", label: "Competitors" },
  { key: "new", label: "New tracker" },
  { key: "scan", label: "Quick scan" },
  { key: "usage", label: "Usage and key" },
];

export function parseView(v: string | undefined): View {
  return VIEWS.some((x) => x.key === v) ? (v as View) : "trackers";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string | undefined): v is string => Boolean(v && UUID.test(v));

export function geogridHref(p: { view?: View; config?: string; run?: string; keyword?: string }): string {
  const q = new URLSearchParams();
  if (p.view && p.view !== "trackers") q.set("view", p.view);
  if (p.config) q.set("config", p.config);
  if (p.run) q.set("run", p.run);
  if (p.keyword) q.set("keyword", p.keyword);
  const s = q.toString();
  return s ? `/geogrid?${s}` : "/geogrid";
}

export function usd(n: number, t: Tr = enT): string {
  if (n > 0 && n < 0.005) return t("money.underCent");
  return `$${n.toFixed(2)}`;
}

export const gridLabel = (size: number, radiusM: number, t: Tr = enT) =>
  t("grid.label", { size, radius: radiusM.toLocaleString("en-US") });

export const SCHEDULE_LABEL = {
  manual: "Manual",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
} as const;

export function monthLine(
  s: {
    monthToDateUsd: number;
    monthlyBudgetUsd: number;
    markupPercent: number;
    isDefault: boolean;
  },
  t: Tr = enT,
  tc: Tr = enTc,
): string {
  return tc(s.isDefault ? "budget.monthLineDefaults" : "budget.monthLine", {
    spent: usd(s.monthToDateUsd, t),
    budget: usd(s.monthlyBudgetUsd, t),
    markup: s.markupPercent,
  });
}

/** The `geogrid.preview` output this page uses. */
export type CostPreview = {
  points: number;
  keywordCount: number;
  estimateUsd: number;
  markupPercent: number;
  byoKey: boolean;
  monthToDateUsd: number;
  monthlyBudgetUsd: number;
  remainingUsd: number;
  wouldExceed: boolean;
};

export function costLine(p: CostPreview, t: Tr = enT, tc: Tr = enTc): string {
  const kw = t("cost.keywords", { count: p.keywordCount });
  const how = p.byoKey ? tc("cost.howOwn") : tc("cost.howMarkup", { markup: p.markupPercent });
  return t("cost.line", { points: p.points, keywords: kw, estimate: usd(p.estimateUsd, t), how });
}

export function budgetLine(p: CostPreview, t: Tr = enT, tc: Tr = enTc): string {
  return tc("cost.budgetLine", {
    spent: usd(p.monthToDateUsd, t),
    budget: usd(p.monthlyBudgetUsd, t),
    left: usd(Math.max(0, p.remainingUsd), t),
  });
}

export function progressLine(
  status: string,
  progress: { collected: number; total: number },
  t: Tr = enT,
): string | null {
  if (status === "queued") return t("progress.queued", progress);
  if (status === "running") return t("progress.running", progress);
  return null;
}

/** Splits a leading `CODE: ` off a stored run error so it renders as the usual `CODE: message`. */
export function runErrorParts(error: string): { code: string | null; message: string } {
  const m = /^([A-Z][A-Z0-9_]*): ([\s\S]*)$/.exec(error);
  return m ? { code: m[1]!, message: m[2]! } : { code: null, message: error };
}

export type RunLite = {
  id: string;
  keyword: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  summary: { averageRank: number | null };
};

/** Previous and next finished scan of the same keyword (the current run may itself be unfinished). */
export function adjacentScans<T extends RunLite>(
  runs: T[],
  current: T,
): { previous: T | null; next: T | null } {
  const same = runs
    .filter((r) => r.keyword === current.keyword && (r.status === "done" || r.id === current.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const i = same.findIndex((r) => r.id === current.id);
  return {
    previous: i > 0 ? same[i - 1]! : null,
    next: i >= 0 && i < same.length - 1 ? same[i + 1]! : null,
  };
}

/** A lower average rank is better, so a drop in the number is "Up". */
export function rankDelta(
  current: number | null,
  previous: number | null,
  t: Tr = enT,
): { label: string; tone: "good" | "bad" | "neutral" } | null {
  if (current === null || previous === null) return null;
  const d = Math.round((previous - current) * 10) / 10;
  if (d > 0) return { label: t("delta.up", { value: d.toFixed(1) }), tone: "good" };
  if (d < 0) return { label: t("delta.down", { value: Math.abs(d).toFixed(1) }), tone: "bad" };
  return { label: t("delta.same"), tone: "neutral" };
}

/** `runs` newest first, as geogrid.runs.list returns them. */
export function defaultRunId(runs: RunLite[], favorites: string[]): string | null {
  const done = runs.filter((r) => r.status === "done");
  for (const f of favorites) {
    const hit = done.find((r) => r.keyword === f);
    if (hit) return hit.id;
  }
  return done[0]?.id ?? runs[0]?.id ?? null;
}

export const sortKeywords = (keywords: string[], favorites: string[]) => [
  ...keywords.filter((k) => favorites.includes(k)),
  ...keywords.filter((k) => !favorites.includes(k)),
];

export const toggleFavorite = (favorites: string[], keyword: string) =>
  favorites.includes(keyword) ? favorites.filter((f) => f !== keyword) : [...favorites, keyword];

/** The parts of a `locations.healthcheck` check this page reads. */
export type HealthCheckLite = {
  id: string;
  title: string;
  importance: "necessary" | "important" | "nice";
  status: "pass" | "fail" | "unknown" | "skipped";
  detail: string;
  fix: { label: string; href: string } | null;
};

const IMPORTANCE = { necessary: 0, important: 1, nice: 2 } as const;

export function destLabel(href: string, t: Tr = enT): string {
  if (href.startsWith("/reviews")) return t("dest.reviews");
  if (href.startsWith("/posts")) return t("dest.posts");
  if (/^\/locations\/[^/]+\/media/.test(href)) return t("dest.photos");
  if (/^\/locations\/[^/]+\/profile/.test(href)) return t("dest.profile");
  return t("dest.health");
}

/** Failing checks the app can fix, necessary first, in checklist order within a level. */
export function quickWins(checks: HealthCheckLite[], max = 3, t: Tr = enT) {
  return checks
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.status === "fail" && c.fix)
    .sort((a, b) => IMPORTANCE[a.c.importance] - IMPORTANCE[b.c.importance] || a.i - b.i)
    .slice(0, max)
    .map(({ c }) => ({
      id: c.id,
      text: `${c.title}: ${c.detail}`,
      href: c.fix!.href,
      dest: destLabel(c.fix!.href, t),
    }));
}

type Env = Record<string, string | undefined>;

/** The browser key for the Maps JavaScript API, read at request time on the server. */
export function mapsBrowserKey(env: Env): string | null {
  const k = env.GOOGLE_MAPS_BROWSER_KEY?.trim();
  return k ? k : null;
}

export const rankDataIsSample = (env: Env) =>
  liveStatus(env, false).rows.find((r) => r.key === "rank")?.state !== "live";

export const writesAreOff = (env: Env) =>
  liveStatus(env, false).rows.find((r) => r.key === "writes")?.state !== "live";
