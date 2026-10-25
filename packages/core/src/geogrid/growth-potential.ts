import { GROWTH_POTENTIAL_CONFIG } from "../config/growth-potential";

const { packClickSharePercent: PACK, outsidePackSharePercent } = GROWTH_POTENTIAL_CONFIG;
const PACK_SHARES = [PACK[1].value, PACK[2].value, PACK[3].value];

export type GrowthEstimate = { low: number; high: number };

/**
 * Extra actions a month if every collected grid point where the business is outside the top 3 moved
 * into the top 3. Per point the gain is (target share - share today) with share today taken as the
 * outside-pack value; points already in the top 3 contribute 0. The average gain over all collected
 * points is applied to the location's own monthly actions. Low assumes the new spot is the worst pack
 * slot (3rd); high assumes the average pack slot.
 *
 * `ranks` holds one entry per COLLECTED point (null = not found); pending points are left out by the caller.
 * Returns null when there is nothing to base it on: no points, or no stored performance data (`monthlyActions` null).
 */
export function estimateGrowthPotential(
  ranks: (number | null)[],
  monthlyActions: number | null,
): GrowthEstimate | null {
  if (ranks.length === 0 || monthlyActions === null) return null;
  const outside = ranks.filter((r) => r === null || r > 3).length;
  const missing = outside / ranks.length;
  const lowTarget = Math.min(...PACK_SHARES);
  const highTarget = PACK_SHARES.reduce((a, b) => a + b, 0) / PACK_SHARES.length;
  const gain = (target: number) => Math.max(0, target - outsidePackSharePercent) / 100;
  return {
    low: Math.max(0, Math.floor(monthlyActions * missing * gain(lowTarget) + 1e-9)),
    high: Math.max(0, Math.ceil(monthlyActions * missing * gain(highTarget) - 1e-9)),
  };
}
