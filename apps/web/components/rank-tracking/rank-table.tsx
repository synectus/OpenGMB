import { useTranslations } from "next-intl";
import {
  BAND_CLASS,
  bandOf,
  heatRows,
  legendFor,
  pinLabel,
  pinTitle,
  type MapPoint,
} from "../../lib/rank-map";

export function RankLegend({ points }: { points: MapPoint[] }) {
  const t = useTranslations("geogrid");
  return (
    <ul aria-label={t("legend.label")} className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
      {legendFor(points, t).map((l) => (
        <li key={l.label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={`inline-block size-3.5 rounded-full ${
              l.band === "ring"
                ? "border-[3px] border-foreground bg-card"
                : l.band === "pending"
                  ? "border border-dashed border-input bg-card"
                  : BAND_CLASS[l.band]
            }`}
          />
          {l.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * The screen-reader and no-map view of the same ranks. Open by default when there is no street map.
 * One <td> per point, north at the top, west on the left; the rank is printed in every cell.
 */
export function RankTable({
  points,
  size,
  targetName,
  open,
}: {
  points: MapPoint[];
  size: number;
  targetName: string;
  open: boolean;
}) {
  const t = useTranslations("geogrid");
  return (
    <details open={open} className="text-sm">
      <summary className="cursor-pointer font-semibold text-brand-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {t("table.summary")}
      </summary>
      <table aria-label={t("table.label")} className="mt-2 border-separate border-spacing-1">
        <tbody>
          {heatRows(points, size).map((row, r) => (
            <tr key={r}>
              {row.map((p) => (
                <td
                  key={p.col}
                  title={pinTitle(p, size, targetName, t)}
                  className={`size-9 rounded text-center text-xs font-bold tabular-nums ${BAND_CLASS[bandOf(p.rank, p.pending)]} ${p.pending ? "border border-dashed border-input" : ""}`}
                >
                  {pinLabel(p.rank, p.pending)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
