// apps/web/lib/review-analytics.ts
// Pure logic for the Analytics tab. No React, no core runtime imports (types only), except the time helpers.
import { dayKey as coreDayKey, startOfZonedDay } from "@opengmb/core/time";
import { enTr, type Tr } from "./reviews-tools-t";
import type { TimeFormat } from "./time-format";

export type Totals = {
  count: number;
  rated: number;
  avgRating: number | null;
  replied: number;
  replyRate: number | null;
  medianReplyHours: number | null;
  needsReply: number;
};
export type MonthRow = { month: string; total: number; low: number; avg: number | null };

/** Same as core ANALYTICS_CONFIG.maxDays; core rejects longer ranges anyway. */
const MAX_DAYS = 800;
/** A location row turns red above this many reviews still needing a reply (the board's threshold). */
export const UNREPLIED_ALERT = 3;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export type Period = {
  key: "12m" | "90d" | "custom";
  from: Date;
  to: Date;
  label: string;
  /** Form values to show again. */
  fromDay: string;
  toDay: string;
  notice: string | null;
};

const addDays = (key: string, n: number) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS;

/** Periods are calendar days in the client's zone (`tf`, for workspace `ws`), so "today" is the client's today. */
export function resolvePeriod(sp: { period?: string; from?: string; to?: string }, now: Date, tf: TimeFormat, ws?: string | null, t: Tr = enTr): Period {
  const zone = tf.zone(ws);
  const todayKey = coreDayKey(now, zone);
  const tomorrowKey = addDays(todayKey, 1);
  const tomorrow = startOfZonedDay(tomorrowKey, zone);
  const build = (key: Period["key"], fromKey: string, label: string, notice: string | null): Period => ({
    key, from: startOfZonedDay(fromKey, zone), to: tomorrow, label, fromDay: fromKey, toDay: todayKey, notice,
  });
  const twelve = (notice: string | null) =>
    build("12m", `${addMonths(todayKey.slice(0, 7), -11)}-01`, t("analytics.periodLast12"), notice);
  if (sp.period === "90d") return build("90d", addDays(tomorrowKey, -90), t("analytics.periodLast90"), null);
  if (sp.period === "custom") {
    const ok = sp.from && sp.to && DAY.test(sp.from) && DAY.test(sp.to);
    const from = ok ? new Date(`${sp.from}T00:00:00Z`) : null;
    const to = ok ? new Date(`${sp.to}T00:00:00Z`) : null;
    if (from && to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from <= to && daysBetween(sp.from!, sp.to!) + 1 <= MAX_DAYS) {
      return {
        key: "custom",
        from: startOfZonedDay(sp.from!, zone),
        to: startOfZonedDay(addDays(sp.to!, 1), zone),
        label: t("analytics.periodCustom", { from: tf.day(sp.from!, ws), to: tf.day(sp.to!, ws) }),
        fromDay: sp.from!,
        toDay: sp.to!,
        notice: null,
      };
    }
    return twelve(t("analytics.periodInvalid"));
  }
  return twelve(null);
}

/** `YYYY-MM` shifted by `n` months. */
const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

export const stars = (n: number | null, t: Tr = enTr) => (n === null ? t("none") : `${n.toFixed(1)}★`);
export const pct = (r: number | null, t: Tr = enTr) => (r === null ? t("none") : `${Math.round(r * 100)}%`);

export function hoursPhrase(h: number, t: Tr = enTr): string {
  if (h < 1) return t("analytics.hoursUnder");
  if (h < 72) return t("analytics.hoursN", { count: Math.round(h) });
  return t("analytics.daysN", { count: Math.round(h / 24) });
}
export const hoursShort = (h: number, t: Tr = enTr) =>
  h < 1 ? t("analytics.shortLt1") : h < 72 ? t("analytics.shortH", { count: Math.round(h) }) : t("analytics.shortD", { count: Math.round(h / 24) });

/** Difference of the numbers as shown (one decimal), so the sentence and the tile agree. */
const diff1 = (a: number, b: number) => Math.round((a - b) * 10) / 10;

export function headline(o: { scope: string; label: string; cur: Totals; prev: Totals }, t: Tr = enTr): string {
  const { scope, label, cur, prev } = o;
  if (cur.count === 0) return t("analytics.headlineNone", { scope, label });
  const parts: string[] = [];
  if (cur.avgRating !== null) {
    const base = { scope, label, rating: stars(cur.avgRating, t) };
    if (prev.avgRating !== null) {
      const d = diff1(cur.avgRating, prev.avgRating);
      parts.push(
        d > 0
          ? t("analytics.headlineUp", { ...base, diff: d.toFixed(1) })
          : d < 0
            ? t("analytics.headlineDown", { ...base, diff: Math.abs(d).toFixed(1) })
            : t("analytics.headlineSame", base),
      );
    } else parts.push(t("analytics.headlineAvg", base));
  } else {
    parts.push(t("analytics.headlineNoStars", { scope, label, count: cur.count }));
  }
  if (cur.replyRate !== null) {
    const rate = pct(cur.replyRate, t);
    parts.push(
      cur.medianReplyHours !== null
        ? t("analytics.headlineReplyWithin", { rate, time: hoursPhrase(cur.medianReplyHours, t) })
        : t("analytics.headlineReply", { rate }),
    );
  }
  return parts.join(" ");
}

export type Kpi = { label: string; value: string; delta: string | null; tone: "good" | "bad" | "neutral"; note: string };
function signed(d: number, text: string, t: Tr, goodWhenUp = true): Pick<Kpi, "delta" | "tone"> {
  if (d === 0) return { delta: t("analytics.noChange"), tone: "neutral" };
  const up = d > 0;
  return { delta: `${up ? "▲" : "▼"} ${text}`, tone: up === goodWhenUp ? "good" : "bad" };
}

export function kpiCards(cur: Totals, prev: Totals, t: Tr = enTr): Kpi[] {
  const noPrior = t("analytics.noPrior");
  const ratingLabel = t("analytics.kpiRating");
  const rating: Kpi =
    cur.avgRating !== null && prev.avgRating !== null
      ? { label: ratingLabel, value: stars(cur.avgRating, t), ...signed(diff1(cur.avgRating, prev.avgRating), Math.abs(diff1(cur.avgRating, prev.avgRating)).toFixed(1), t), note: t("analytics.vsPrevRating", { rating: stars(prev.avgRating, t) }) }
      : { label: ratingLabel, value: cur.avgRating === null ? t("noneCap") : stars(cur.avgRating, t), delta: null, tone: "neutral", note: noPrior };
  const change = prev.count > 0 ? Math.round(((cur.count - prev.count) / prev.count) * 100) : null;
  const volume: Kpi = {
    label: t("analytics.kpiNew"),
    value: String(cur.count),
    ...(change === null ? { delta: null, tone: "neutral" as const } : signed(change, `${Math.abs(change)}%`, t)),
    note: prev.count > 0 ? t("analytics.vsCount", { count: prev.count }) : noPrior,
  };
  const rateLabel = t("analytics.kpiReplyRate");
  const rate: Kpi =
    cur.replyRate !== null && prev.replyRate !== null
      ? (() => {
          const pts = Math.round(cur.replyRate * 100) - Math.round(prev.replyRate * 100);
          return { label: rateLabel, value: pct(cur.replyRate, t), ...signed(pts, t("analytics.pts", { count: Math.abs(pts) }), t), note: t("analytics.repliedOf", { replied: cur.replied, count: cur.count }) };
        })()
      : { label: rateLabel, value: pct(cur.replyRate, t), delta: null, tone: "neutral", note: cur.count ? t("analytics.repliedOf", { replied: cur.replied, count: cur.count }) : t("analytics.noReviewsPeriod") };
  const timeLabel = t("analytics.kpiMedian");
  const time: Kpi =
    cur.medianReplyHours !== null && prev.medianReplyHours !== null
      ? (() => {
          const d = Math.round(cur.medianReplyHours) - Math.round(prev.medianReplyHours);
          return {
            label: timeLabel,
            value: hoursShort(cur.medianReplyHours, t),
            ...signed(d, hoursShort(Math.abs(d), t), t, false),
            note: d < 0 ? t("analytics.faster") : d > 0 ? t("analytics.slower") : t("analytics.sameAsBefore"),
          };
        })()
      : { label: timeLabel, value: cur.medianReplyHours === null ? t("noneCap") : hoursShort(cur.medianReplyHours, t), delta: null, tone: "neutral", note: cur.medianReplyHours === null ? t("analytics.noRepliesToTime") : noPrior };
  return [rating, volume, rate, time];
}

// --- chart: 720 x 240 viewBox, plot from x 52 to 706, bars grow up from y 200 ---
const BASE = 200;
const PLOT_H = 160;
const X0 = 52;
const X1 = 706;
const MONTH = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function niceMax(n: number): number {
  const unit = n <= 100 ? 10 : n <= 500 ? 50 : 100;
  return Math.max(10, Math.ceil(n / unit) * unit);
}

export function monthLabel(key: string, withYear: boolean, t: Tr = enTr): string {
  const [y, m] = key.split("-");
  return `${t(`analytics.${MONTH[Number(m) - 1]}`)}${withYear ? ` ${y!.slice(2)}` : ""}`;
}

export type ChartBar = { label: string; x: number; cx: number; width: number; yTop: number; hHigh: number; yLow: number; hLow: number; total: number };

export function chartModel(months: MonthRow[], t: Tr = enTr) {
  const axisMax = niceMax(Math.max(0, ...months.map((m) => m.total)));
  const slot = (X1 - X0) / Math.max(1, months.length);
  const width = Math.min(34, Math.floor(slot * 0.62));
  const withYear = months.length > 12;
  const bars: ChartBar[] = months.map((m, i) => {
    const x = Math.round(X0 + i * slot + (slot - width) / 2);
    const h = Math.round((m.total / axisMax) * PLOT_H);
    const hLow = Math.round((m.low / axisMax) * PLOT_H);
    return { label: monthLabel(m.month, withYear, t), x, cx: x + width / 2, width, yTop: BASE - h, hHigh: h - hLow, yLow: BASE - hLow, hLow, total: m.total };
  });
  const line = months
    .flatMap((m, i) => (m.avg === null ? [] : [`${bars[i]!.cx},${BASE - (Math.min(5, Math.max(4, m.avg)) - 4) * PLOT_H}`]))
    .join(" ");
  return { axisMax, ticks: [0, axisMax / 2, axisMax], bars, line };
}

export function chartLabel(months: MonthRow[], t: Tr = enTr): string {
  const avgs = months.flatMap((m) => (m.avg === null ? [] : [m.avg]));
  const total = months.reduce((n, m) => n + m.total, 0);
  const range = avgs.length ? t("analytics.chartRange", { lo: Math.min(...avgs).toFixed(1), hi: Math.max(...avgs).toFixed(1) }) : "";
  return t("analytics.chartSummary", { total, months: months.length, range });
}

const STAR_FILL: Record<number, string> = { 5: "bg-chart-1", 4: "bg-chart-1", 3: "bg-muted-foreground", 2: "bg-bad", 1: "bg-bad" };

export function starBars(stars: { star: number; count: number }[]) {
  const total = stars.reduce((n, s) => n + s.count, 0);
  return stars.map((s) => ({ star: `${s.star}★`, n: s.count, pct: total ? Math.round((s.count / total) * 100) : 0, fill: STAR_FILL[s.star] ?? "bg-muted-foreground" }));
}

/** Points for an 80 x 22 sparkline of monthly averages; "" with fewer than two points. */
export function sparkPoints(monthly: (number | null)[]): string {
  const pts = monthly.flatMap((v, i) => (v === null ? [] : [[i, v] as const]));
  if (pts.length < 2) return "";
  const vs = pts.map((p) => p[1]);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const last = Math.max(1, monthly.length - 1);
  return pts
    .map(([i, v]) => `${Math.round((i / last) * 80)},${hi === lo ? 11 : Math.round(18 - ((v - lo) / (hi - lo)) * 14)}`)
    .join(" ");
}

export function scopeLabel(o: {
  ws?: string;
  loc?: string;
  workspaces: { id: string; name: string }[];
  locations: { id: string; name: string; workspaceId: string }[];
}, t: Tr = enTr): string {
  const loc = o.loc ? o.locations.find((l) => l.id === o.loc) : undefined;
  if (loc) return loc.name;
  const ws = o.ws ? o.workspaces.find((w) => w.id === o.ws) : undefined;
  if (ws) return ws.name;
  return o.workspaces.length === 1 ? o.workspaces[0]!.name : t("analytics.scopeAll");
}
