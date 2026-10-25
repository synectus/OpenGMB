// Pure render data for the "Growth potential" panel on a rank-tracking run. Server-side only: it reads
// the core estimator. No React; unit tested.
import { estimateGrowthPotential } from "@opengmb/core";
import type { MapPoint } from "./rank-map";
import { enT, type Tr } from "./rank-tracking";

/** The location's own stored Performance API numbers for the last 30 complete days. */
export type GrowthPerformance = {
  /** Newest day stored for the location, any metric; null when nothing was ever captured. */
  lastDataDate: string | null;
  /** calls + website clicks + direction requests in the period. */
  actions: number;
  from: string;
  to: string;
};

export type GrowthView =
  | { kind: "note"; text: string }
  | { kind: "estimate"; text: string; basis: string; disclaimer: string };

const n = (v: number) => v.toLocaleString("en-US");

export function growthPotentialView(p: {
  sample: boolean;
  targetName: string;
  points: Pick<MapPoint, "rank" | "pending">[];
  performance: GrowthPerformance | null;
  t?: Tr;
}): GrowthView {
  const t = p.t ?? enT;
  if (p.sample) return { kind: "note", text: t("growth.sample") };
  const ranks = p.points.filter((x) => !x.pending).map((x) => x.rank);
  if (ranks.length === 0) return { kind: "note", text: t("growth.noPoints") };
  if (ranks.every((r) => r !== null && r <= 3)) return { kind: "note", text: t("growth.allTop3") };
  if (!p.performance || p.performance.lastDataDate === null) return { kind: "note", text: t("growth.noData") };
  if (p.performance.actions === 0) return { kind: "note", text: t("growth.noActions") };
  const e = estimateGrowthPotential(ranks, p.performance.actions)!;
  const text =
    e.low === 0
      ? t("growth.rangeUpTo", { name: p.targetName, count: n(e.high) })
      : t("growth.range", { name: p.targetName, low: n(e.low), high: n(e.high) });
  return {
    kind: "estimate",
    text,
    basis: t("growth.basis", { actions: n(p.performance.actions), from: p.performance.from, to: p.performance.to }),
    disclaimer: t("growth.disclaimer"),
  };
}
