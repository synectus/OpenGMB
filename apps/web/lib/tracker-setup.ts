// Pure logic for the New tracker and Usage and key tabs. Unit tested; no React.
import { enT, enTc, usd, type Tr } from "./rank-tracking";
import type { TimeFormat } from "./time-format";

/** Same rules as geogrid.configs.create (which stays the authority): 1 to 5, unique ignoring case. */
const MAX_KEYWORDS = 5;

export function parseKeywords(text: string, t: Tr = enT): { keywords: string[]; error: string | null } {
  const keywords = text
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (keywords.length === 0) return { keywords, error: t("setupCheck.keywordNone") };
  if (new Set(keywords.map((k) => k.toLowerCase())).size !== keywords.length) {
    return { keywords, error: t("setupCheck.keywordDuplicate") };
  }
  if (keywords.length > MAX_KEYWORDS) return { keywords, error: t("setupCheck.keywordMax", { max: MAX_KEYWORDS }) };
  return { keywords, error: null };
}

/** Mirrors buildGrid's check in core (|lat| <= 85, |lng| <= 180). */
export function checkCoords(lat: string, lng: string, t: Tr = enT): string | null {
  if (lat.trim() === "" || lng.trim() === "") return t("setupCheck.coordsMissing");
  const a = Number(lat);
  const o = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(o)) {
    return t("setupCheck.coordsNotNumber");
  }
  if (Math.abs(a) > 85) return t("setupCheck.latRange");
  if (Math.abs(o) > 180) return t("setupCheck.lngRange");
  return null;
}

export const usdPrecise = (n: number) => `$${n.toFixed(4)}`;

export function priceLine(
  d: {
    id: "dataforseo_standard" | "places_relevance" | "dataforseo_serp";
    perTaskUsd: number;
    priceVerifiedOn: string;
    priceStatus: "verified" | "unverified";
  },
  t: Tr = enT,
): string {
  const price =
    d.perTaskUsd === 0 ? t("price.noCharge") : t("price.perTask", { price: usdPrecise(d.perTaskUsd) });
  const kind = d.id === "dataforseo_standard" ? "Dfs" : "Relevance";
  return t(`price.${d.priceStatus === "verified" ? "verified" : "unverified"}${kind}`, {
    price,
    date: d.priceVerifiedOn,
  });
}

/** "2026-05" -> "May 2026" */
export function monthLabel(ym: string, t: Tr = enT): string {
  const [y, m] = ym.split("-");
  const n = Number(m);
  return t("months.label", { month: n >= 1 && n <= 12 ? t(`months.m${n}`) : String(m), year: String(y) });
}

export function keyStatusLine(k: {
  configured: boolean;
  login: string | null;
  lastVerifiedAt: string | null;
}, tf: TimeFormat, t: Tr = enT, tc: Tr = enTc): string {
  if (!k.configured) return tc("key.none");
  const login = String(k.login);
  return k.lastVerifiedAt
    ? t("key.verified", { login, when: tf.dateTime(k.lastVerifiedAt) })
    : t("key.notVerified", { login });
}

type Bucket = { runs: number; points: number; tasks: number; costAtDataforseoUsd: number; chargedUsd: number };

/** geogrid.usage months -> table rows, skipping a key that was not used that month. */
export function usageRows(months: { month: string; byo: Bucket; resold: Bucket; total?: Bucket }[], t: Tr = enT, tc: Tr = enTc) {
  const n = (x: number) => x.toLocaleString("en-US");
  return months.flatMap((m) =>
    (
      [
        [t("key.byo"), m.byo],
        [tc("key.resold"), m.resold],
      ] as const
    )
      .filter(([, b]) => b.runs > 0)
      .map(([key, b]) => ({
        month: monthLabel(m.month, t),
        key,
        runs: b.runs,
        points: n(b.points),
        tasks: n(b.tasks),
        cost: usd(b.costAtDataforseoUsd, t),
        charged: usd(b.chargedUsd, t),
      })),
  );
}
