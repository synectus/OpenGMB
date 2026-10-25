// apps/web/lib/share-page.ts
// Pure logic for the public share page /r/[token]. No core value imports (web lib tests run
// without the database package); the sentence rules are 4A's.
import type { TimeFormat } from "./time-format";
import { addDays, daysIn, enTr, monthSpan, outcomeSentence, periodPhrase, tileDelta, type KpiDelta, type Tr, type TileDelta } from "./performance";

/** English for every string built in this file. messages/pages/reports.ts spreads it into `en`. */
export const SHARE_EN = {
  sublineOne: "{client} · 1 location · {from} to {to}",
  sublineMany: "{client} · {n} locations · {from} to {to}",
  keywordNoteMonths: "{span}, unique users. Google hides small counts.",
  keywordNote: "Unique users. Google hides small counts.",
  keywordBelow: "Below {n}",
  sizeMb: "PDF, {size} MB",
  sizeKb: "PDF, {size} KB",
  expiryLine: "This link expires on {date}. It was shared by {agency}.",
  expiredTitle: "This link has expired",
  revokedTitle: "This link was turned off",
  newLinkBody: "Ask {agency} for a new link.",
  invalidTitle: "This link does not work",
  invalidBody: "Check that you copied the whole address.",
} as const;
const en = enTr(SHARE_EN);

const num = (n: number) => n.toLocaleString("en-US");
const ORDER = ["calls", "websiteClicks", "directions", "impressionsMaps", "impressionsSearch"] as const;

export function shareTiles(kpis: (KpiDelta & { label: string })[], tPerf?: Tr): { key: string; label: string; value: string; delta: TileDelta }[] {
  return ORDER.flatMap((key) => {
    const k = kpis.find((x) => x.key === key);
    return k ? [{ key, label: k.label, value: num(k.total), delta: tileDelta(k, tPerf) }] : [];
  });
}

/**
 * The outcome sentence for a shared report. `today` is set past the period end so the phrase never
 * says "the last 30 days": a shared report is read days or weeks later.
 */
export function shareSentence(c: { periodStart: string; periodEnd: string; kpis: KpiDelta[] }, tf: TimeFormat, ws?: string | null, tPerf?: Tr): string | null {
  const range = { from: c.periodStart, to: c.periodEnd };
  return outcomeSentence(c.kpis, periodPhrase(range, addDays(c.periodEnd, 2), tf, ws, tPerf), daysIn(range), tPerf);
}

export function subline(c: { workspaceName: string; locationCount: number; periodStart: string; periodEnd: string }, tf: TimeFormat, ws?: string | null, t: Tr = en) {
  const n = c.locationCount;
  return t(n === 1 ? "sublineOne" : "sublineMany", { client: c.workspaceName, n, from: tf.day(c.periodStart, ws), to: tf.day(c.periodEnd, ws) });
}

export const keywordNote = (months: string[], t: Tr = en, tPerf?: Tr) =>
  months.length ? t("keywordNoteMonths", { span: monthSpan(months, tPerf) }) : t("keywordNote");

export function shareKeywordUsers(k: { value: number; isLowerBound: boolean; hiddenBelow: number }, t: Tr = en) {
  if (!k.isLowerBound) return num(k.value);
  return k.value > 0 ? `${num(k.value)}+` : t("keywordBelow", { n: num(k.hiddenBelow) });
}

export function formatSize(bytes: number | null, t: Tr = en): string | null {
  if (bytes == null) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? t("sizeMb", { size: mb.toFixed(1) }) : t("sizeKb", { size: Math.max(1, Math.round(bytes / 1024)) });
}

export const expiryLine = (expiresAt: string, agency: string, tf: TimeFormat, ws?: string | null, t: Tr = en) =>
  t("expiryLine", { date: tf.date(expiresAt, ws), agency });

/** Messages for links that cannot be shown. An unknown link names no one. */
export function deniedCopy(status: "expired" | "revoked" | "invalid" | "not_ready", agency: string | null, t: Tr = en) {
  if (status === "expired") return { title: t("expiredTitle"), body: t("newLinkBody", { agency: agency ?? "" }) };
  if (status === "revoked") return { title: t("revokedTitle"), body: t("newLinkBody", { agency: agency ?? "" }) };
  return { title: t("invalidTitle"), body: t("invalidBody") };
}
