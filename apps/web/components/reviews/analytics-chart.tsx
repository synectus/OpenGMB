// apps/web/components/reviews/analytics-chart.tsx
import type { Tr } from "../../lib/reviews-tools-t";
import { chartLabel, chartModel, type MonthRow } from "../../lib/review-analytics";

export function VolumeChart({ months, t }: { months: MonthRow[]; t: Tr }) {
  const c = chartModel(months, t);
  return (
    <svg role="img" aria-label={chartLabel(months, t)} viewBox="0 0 720 240" width="100%" height="240">
      {c.ticks.map((t, i) => {
        const y = 200 - (t / c.axisMax) * 160;
        return (
          <g key={i}>
            <line x1="40" x2="710" y1={y} y2={y} className="stroke-border" />
            <text x="32" y={y + 4} textAnchor="end" fontSize="11" className="fill-muted-foreground">{Math.round(t)}</text>
          </g>
        );
      })}
      {c.bars.map((b) => (
        <g key={b.label + b.x}>
          <rect x={b.x} y={b.yTop} width={b.width} height={b.hHigh} rx="4" className="fill-chart-1" />
          <rect x={b.x} y={b.yLow} width={b.width} height={b.hLow} className="fill-bad" />
          <text x={b.cx} y="220" textAnchor="middle" fontSize="11" className="fill-muted-foreground">{b.label}</text>
        </g>
      ))}
      {c.line && <polyline points={c.line} fill="none" strokeWidth="2.5" className="stroke-brand" />}
    </svg>
  );
}
