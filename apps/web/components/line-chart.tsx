import { useTranslations } from "next-intl";

type Point = { date: string; value: number };

const W = 960;
const H = 260;
const L = 48;
const R = 12;
const T = 12;
const B = 32;

/**
 * Inline SVG line chart: the current period solid, the previous period dashed, labelled axes, a text
 * alternative and a "Show the numbers" table. Colours are tokens so both themes stay readable.
 */
export function LineChart({
  id,
  label,
  points,
  previous,
  legend,
}: {
  id: string;
  label: string;
  points: Point[];
  previous?: Point[];
  legend?: { current: string; previous: string };
}) {
  const t = useTranslations("performance");
  const prev = previous ?? [];
  const max = Math.max(1, ...points.map((p) => p.value), ...prev.map((p) => p.value));
  const x = (i: number) => L + (points.length <= 1 ? 0 : (i * (W - L - R)) / (points.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const path = (ps: Point[]) =>
    ps.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const total = points.reduce((n, p) => n + p.value, 0);
  const peak = points.reduce((a, p) => (p.value > a.value ? p : a), points[0] ?? { date: "", value: 0 });
  const desc = points.length
    ? `${t("chartDescription", { label, from: points[0]!.date, to: points[points.length - 1]!.date, total, peakDate: peak.date, peakValue: peak.value })}${prev.length ? ` ${t("chartDashed")}` : ""}`
    : t("chartNoData", { label });
  const ticks = [0, max / 2, max];
  const xs = points.length ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : [];
  return (
    <figure className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t ${id}-d`} className="w-full">
        <title id={`${id}-t`}>{label}</title>
        <desc id={`${id}-d`}>{desc}</desc>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
            <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize={11} className="fill-muted-foreground">
              {Math.round(t)}
            </text>
          </g>
        ))}
        {xs.map((i) => (
          <text key={i} x={x(i)} y={H - 10} textAnchor="middle" fontSize={11} className="fill-muted-foreground">
            {points[i]!.date}
          </text>
        ))}
        {prev.length > 1 && (
          <path d={path(prev)} fill="none" className="stroke-muted-foreground" strokeWidth={2} strokeDasharray="6 4" strokeLinejoin="round" />
        )}
        {points.length > 0 && (
          <path d={path(points)} fill="none" className="stroke-foreground" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {points.length > 0 && (
          <circle cx={x(points.length - 1)} cy={y(points[points.length - 1]!.value)} r={4} className="fill-foreground" />
        )}
      </svg>
      {legend && (
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <svg aria-hidden width="26" height="8" viewBox="0 0 26 8">
              <path d="M1 4h24" className="stroke-foreground" strokeWidth={3} strokeLinecap="round" />
            </svg>
            {legend.current}
          </span>
          {prev.length > 0 && (
            <span className="inline-flex items-center gap-2">
              <svg aria-hidden width="26" height="8" viewBox="0 0 26 8">
                <path d="M1 4h24" className="stroke-muted-foreground" strokeWidth={2} strokeDasharray="5 3" strokeLinecap="round" />
              </svg>
              {legend.previous}
            </span>
          )}
        </div>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer font-semibold text-brand-text underline underline-offset-2">{t("showNumbers")}</summary>
        <div className="mt-2 overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-sm tabular-nums">
            <thead className="border-b border-border bg-muted">
              <tr>
                <th scope="col" className="px-3 py-2 text-xs font-semibold text-muted-foreground">{t("day")}</th>
                <th scope="col" className="px-3 py-2 text-xs font-semibold text-muted-foreground">{label}</th>
                {prev.length > 0 && (
                  <>
                    <th scope="col" className="px-3 py-2 text-xs font-semibold text-muted-foreground">{t("sameDayBefore")}</th>
                    <th scope="col" className="px-3 py-2 text-xs font-semibold text-muted-foreground">{t("labelBefore", { label })}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {points.map((p, i) => (
                <tr key={p.date}>
                  <td className="px-3 py-1.5">{p.date}</td>
                  <td className="px-3 py-1.5">{p.value}</td>
                  {prev.length > 0 && (
                    <>
                      <td className="px-3 py-1.5">{prev[i]?.date ?? ""}</td>
                      <td className="px-3 py-1.5">{prev[i]?.value ?? ""}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
