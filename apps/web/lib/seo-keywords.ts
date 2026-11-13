// Pure display helpers for /seo/keywords. No React; unit tested.
import { createTranslator } from "next-intl";
import seoKeywords from "../messages/pages/seoKeywords";

export type Tr = (key: string, values?: Record<string, string | number>) => string;
export const enT: Tr = createTranslator({ locale: "en", messages: { seoKeywords: seoKeywords.en }, namespace: "seoKeywords" }) as unknown as Tr;

/** The markets keyword research offers (the same seven as rank tracking). */
export const SEO_COUNTRIES = ["US", "IN", "AU", "GB", "CA", "NZ", "AE"] as const;
export type SeoCountry = (typeof SEO_COUNTRIES)[number];

export function formatVolume(n: number | null | undefined, t: Tr = enT): string {
  return n === null || n === undefined ? t("labels.noData") : n.toLocaleString("en-US");
}

/** Keyword difficulty bands: 0-29 easy, 30-59 medium, 60-100 hard. */
export function kdLabel(kd: number | null | undefined, t: Tr = enT): string {
  if (kd === null || kd === undefined) return t("labels.noData");
  return t(kd < 30 ? "labels.easy" : kd < 60 ? "labels.medium" : "labels.hard");
}

export function intentLabel(intent: string, t: Tr = enT): string {
  const known = ["informational", "commercial", "transactional", "navigational"];
  return t(`labels.${known.includes(intent) ? intent : "unknown"}`);
}

export function seoKeywordsHref(p: { ws?: string; run?: string; location?: string } = {}): string {
  const q = new URLSearchParams();
  if (p.ws) q.set("ws", p.ws);
  if (p.location) q.set("location", p.location);
  if (p.run) q.set("run", p.run);
  const s = q.toString();
  return s ? `/seo/keywords?${s}` : "/seo/keywords";
}

/** "Austin,Texas,United States" -> "Austin". */
export const shortCity = (geotarget: string): string => geotarget.split(",")[0]!.trim();

/** The city in a Google address summary such as "12 Main St, Austin, TX 78701, US": the last part that has no digit and is not a code. */
export function cityFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    if (/\d/.test(p) || /^[A-Za-z]{2}$/.test(p)) continue;
    return p;
  }
  return null;
}

/** The ISO country at the end of a Google address summary, when it is one we offer. */
export function countryFromAddress(address: string | null | undefined): SeoCountry {
  const last = address?.split(",").at(-1)?.trim().toUpperCase();
  return (SEO_COUNTRIES as readonly string[]).includes(last ?? "") ? (last as SeoCountry) : "US";
}

export type PriceEstimate = {
  chargedUsd: number;
  cached: boolean;
  cachedAt: string | null;
  /** The reused search is still queued or running. */
  inFlight?: boolean;
  source: "fixture" | "sandbox" | "live";
  /** Null when the account is not billed (community edition, complimentary): no credit wording then. */
  balanceUsd: number | null;
};
const usd = (n: number) => `$${n.toFixed(2)}`;

/** The one plain line under the form, from the `seoKeywordsCost` translator `tc`. */
export function priceLineText(e: PriceEstimate, tc: Tr): string {
  if (e.cached && e.inFlight) return tc("price.running");
  if (e.cached) return tc("price.cached", { date: (e.cachedAt ?? "").slice(0, 10) });
  if (e.source !== "live") return tc("price.sample", { price: usd(e.chargedUsd) });
  return e.balanceUsd === null ? tc("price.lineNoBalance", { price: usd(e.chargedUsd) }) : tc("price.line", { price: usd(e.chargedUsd), balance: usd(e.balanceUsd) });
}

/** Which refusal a core error is, by its message prefix (core words them for rank scans). Null: show the message as written. */
export function refusalKind(err: { code: string; message: string }): "credit" | "budget" | "platform" | "forbidden" | null {
  if (/^CREDIT_EXHAUSTED/.test(err.message)) return "credit";
  if (/^BUDGET_EXCEEDED/.test(err.message)) return "budget";
  if (/^PLATFORM_CAP_EXCEEDED/.test(err.message)) return "platform";
  if (err.code === "FORBIDDEN" || err.code === "UNAUTHENTICATED") return "forbidden";
  return null;
}

/** A readable sentence for a failed call: never the raw `CODE: message`. */
export function researchErrorText(err: { code: string; message: string }, tc: Tr): string {
  const kind = refusalKind(err);
  return kind ? tc(`errors.${kind}`) : err.message;
}
