// apps/web/lib/performance.ts
// Pure decisions for /performance (and the share page in plan 4E). No core value imports: web lib
// tests run without the database package.
import type { TimeFormat } from "./time-format";

/** A translator: a next-intl `t` for the "performance" namespace, or enTr(PERFORMANCE_EN) (the default, so lib tests need no i18n). */
export type Tr = (key: string, values?: Record<string, string | number>) => string;
export const enTr =
  (table: Record<string, string>): Tr =>
  (key, values) =>
    (table[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(values?.[k] ?? ""));

/** English for every string built in this file. messages/pages/performance.ts spreads it into `en`. */
export const PERFORMANCE_EN = {
  month1: "January", month2: "February", month3: "March", month4: "April", month5: "May", month6: "June",
  month7: "July", month8: "August", month9: "September", month10: "October", month11: "November", month12: "December",
  lessThanOnePct: "less than 1%",
  deltaNoChange: "No change 0%",
  deltaNoEarlier: "no earlier data",
  deltaUp: "Up {pct}",
  deltaDown: "Down {pct}",
  changeSame: "did not change",
  changeNoEarlier: "had no earlier data",
  changeRose: "rose {pct}",
  changeFell: "fell {pct}",
  daysBefore: "the {days} days before",
  leadNone: "{phrase}, Google recorded no calls or direction requests",
  leadOne: "{phrase}, {calls} person called and {directions} asked for directions",
  leadMany: "{phrase}, {calls} people called and {directions} asked for directions",
  outSame: "{lead}, the same as {before}.",
  outNoEarlier: "{lead}. There is no earlier data to compare with.",
  outMore: "{lead}: {a} and {b} more than {before}.",
  outFewer: "{lead}: {a} and {b} fewer than {before}.",
  outMixed: "{lead}. Compared with {before}, calls {calls} and direction requests {directions}.",
  outWebRose: "Website clicks rose {pct}.",
  outWebFell: "Website clicks fell {pct}.",
  periodLast30: "In the last 30 days",
  periodMonth: "In {month}",
  periodRange: "From {from} to {to}",
  monthRange: "{first} to {last}",
  deviceNone: "{name}: no impressions",
  deviceSplit: "{name} {total}: mobile {mobile} ({mobilePct}%), desktop {desktop} ({desktopPct}%)",
  keywordFloor: "{n}+ (some months below Google's threshold)",
  keywordBelow: "below {n}",
} as const;
const enPerf = enTr(PERFORMANCE_EN);

export type KpiDelta = {
  key: string;
  total: number;
  previousTotal: number;
  delta: number;
  deltaPct: number | null;
};
export type DayRange = { from: string; to: string };

const DAY_MS = 86_400_000;

const num = (n: number) => n.toLocaleString("en-US");
const parse = (d: string) => new Date(`${d}T00:00:00Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => ymd(new Date(parse(d).getTime() + n * DAY_MS));
export const daysIn = (r: DayRange) =>
  Math.round((parse(r.to).getTime() - parse(r.from).getTime()) / DAY_MS) + 1;
const monthOnly = (ym: string, t: Tr) => t(`month${Number(ym.slice(5, 7))}`);
const monthName = (ym: string, t: Tr) => `${monthOnly(ym, t)} ${ym.slice(0, 4)}`;
const lastOfMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return ymd(new Date(Date.UTC(y, m, 0)));
};

/** Whole percent of a change; a real change that rounds to 0 is "<1%" (short) or "less than 1%". */
const pct = (deltaPct: number, short: boolean, t: Tr) => {
  const n = Math.round(Math.abs(deltaPct) * 100);
  return n === 0 ? (short ? "<1%" : t("lessThanOnePct")) : `${n}%`;
};

export type TileDelta = {
  text: string;
  tone: "good" | "bad" | "neutral" | "none";
  arrow: "up" | "down" | "flat" | null;
};

/** The tile's change line. No change first, so two zero periods read "No change 0%". */
export function tileDelta(k: Pick<KpiDelta, "delta" | "deltaPct">, t: Tr = enPerf): TileDelta {
  if (k.delta === 0) return { text: t("deltaNoChange"), tone: "neutral", arrow: "flat" };
  if (k.deltaPct === null) return { text: t("deltaNoEarlier"), tone: "none", arrow: null };
  return k.delta > 0
    ? { text: t("deltaUp", { pct: pct(k.deltaPct, true, t) }), tone: "good", arrow: "up" }
    : { text: t("deltaDown", { pct: pct(k.deltaPct, true, t) }), tone: "bad", arrow: "down" };
}

const change = (k: KpiDelta, t: Tr) =>
  k.delta === 0
    ? t("changeSame")
    : k.deltaPct === null
      ? t("changeNoEarlier")
      : t(k.delta > 0 ? "changeRose" : "changeFell", { pct: pct(k.deltaPct, false, t) });

/**
 * "Business outcomes": plain arithmetic, no AI. `phrase` is periodPhrase(); `days` the range length
 * (the comparison is always the equal-length period just before). Null when a KPI is missing.
 */
export function outcomeSentence(kpis: KpiDelta[], phrase: string, days: number, t: Tr = enPerf): string | null {
  const find = (key: string) => kpis.find((x) => x.key === key);
  const calls = find("calls");
  const dirs = find("directions");
  const web = find("websiteClicks");
  if (!calls || !dirs) return null;
  const before = t("daysBefore", { days });
  const lead =
    calls.total === 0 && dirs.total === 0
      ? t("leadNone", { phrase })
      : t(calls.total === 1 ? "leadOne" : "leadMany", { phrase, calls: num(calls.total), directions: num(dirs.total) });
  let out: string;
  if (calls.delta === 0 && dirs.delta === 0) out = t("outSame", { lead, before });
  else if (calls.deltaPct === null && dirs.deltaPct === null) {
    out = t("outNoEarlier", { lead });
  } else if (calls.deltaPct !== null && dirs.deltaPct !== null && calls.delta > 0 && dirs.delta > 0) {
    out = t("outMore", { lead, a: pct(calls.deltaPct, false, t), b: pct(dirs.deltaPct, false, t), before });
  } else if (calls.deltaPct !== null && dirs.deltaPct !== null && calls.delta < 0 && dirs.delta < 0) {
    out = t("outFewer", { lead, a: pct(calls.deltaPct, false, t), b: pct(dirs.deltaPct, false, t), before });
  } else {
    out = t("outMixed", { lead, before, calls: change(calls, t), directions: change(dirs, t) });
  }
  if (web && web.delta !== 0 && web.deltaPct !== null) {
    out += ` ${t(web.delta > 0 ? "outWebRose" : "outWebFell", { pct: pct(web.deltaPct, false, t) })}`;
  }
  return out;
}

/** "In the last 30 days" (ending yesterday), "In September 2026" (a whole month), or the dates. */
export function periodPhrase(r: DayRange, today: string, tf: TimeFormat, ws?: string | null, t: Tr = enPerf): string {
  if (r.to === addDays(today, -1) && daysIn(r) === 30) return t("periodLast30");
  const ym = r.from.slice(0, 7);
  if (r.from.endsWith("-01") && r.to === lastOfMonth(ym)) return t("periodMonth", { month: monthName(ym, t) });
  return t("periodRange", { from: tf.day(r.from, ws), to: tf.day(r.to, ws) });
}

export type Preset = "30" | "90" | "month";
export const PRESETS: { key: Preset; label: string }[] = [
  { key: "30", label: "Last 30 days" },
  { key: "90", label: "Last 90 days" },
  { key: "month", label: "Last month" },
];

/** Presets end yesterday in the client's zone (`today` comes from tf.today()), like core's last30DaysRange; "month" is the previous calendar month. */
export function presetRange(key: Preset, today: string): DayRange {
  const y = addDays(today, -1);
  if (key === "30") return { from: addDays(y, -29), to: y };
  if (key === "90") return { from: addDays(y, -89), to: y };
  const firstOfThis = `${today.slice(0, 7)}-01`;
  const to = addDays(firstOfThis, -1);
  return { from: `${to.slice(0, 7)}-01`, to };
}

export function matchPreset(r: DayRange, today: string): Preset | null {
  return PRESETS.find((p) => {
    const x = presetRange(p.key, today);
    return x.from === r.from && x.to === r.to;
  })?.key ?? null;
}

/** "July to September 2026", "December 2025 to January 2026", "September 2026". */
export function monthSpan(months: string[], t: Tr = enPerf): string {
  if (months.length === 0) return "";
  const first = months[0]!;
  const last = months[months.length - 1]!;
  if (first === last) return monthName(first, t);
  if (first.slice(0, 4) === last.slice(0, 4)) {
    return t("monthRange", { first: monthOnly(first, t), last: monthName(last, t) });
  }
  return t("monthRange", { first: monthName(first, t), last: monthName(last, t) });
}

export type DeviceRow = {
  name: "Google Maps" | "Google Search";
  total: number;
  mobile: number;
  desktop: number;
  mobilePct: number | null;
  desktopPct: number | null;
  label: string;
};

/** Mobile and desktop impressions for Maps and Search from performance.summary's `metrics`. */
export function deviceSplit(metrics: { metric: string; total: number }[], t: Tr = enPerf): DeviceRow[] {
  const get = (m: string) => metrics.find((x) => x.metric === m)?.total ?? 0;
  return (
    [
      ["Google Maps", "MAPS"],
      ["Google Search", "SEARCH"],
    ] as const
  ).map(([name, kind]) => {
    const mobile = get(`BUSINESS_IMPRESSIONS_MOBILE_${kind}`);
    const desktop = get(`BUSINESS_IMPRESSIONS_DESKTOP_${kind}`);
    const total = mobile + desktop;
    const mobilePct = total ? Math.round((mobile / total) * 100) : null;
    const desktopPct = mobilePct === null ? null : 100 - mobilePct;
    const label =
      total === 0
        ? t("deviceNone", { name })
        : t("deviceSplit", { name, total: num(total), mobile: num(mobile), mobilePct: mobilePct!, desktop: num(desktop), desktopPct: desktopPct! });
    return { name, total, mobile, desktop, mobilePct, desktopPct, label };
  });
}

/** Unique users for a keyword row (same rules as the PDF). */
export function keywordUsers(k: { value: number; isLowerBound: boolean; hiddenBelow: number }, t: Tr = enPerf) {
  if (!k.isLowerBound) return num(k.value);
  return k.value > 0 ? t("keywordFloor", { n: num(k.value) }) : t("keywordBelow", { n: num(k.hiddenBelow) });
}

export function performanceHref(p: { ws?: string; from?: string; to?: string; kpi?: string }) {
  const q = new URLSearchParams();
  for (const k of ["ws", "from", "to", "kpi"] as const) if (p[k]) q.set(k, p[k]!);
  const s = q.toString();
  return s ? `/performance?${s}` : "/performance";
}
