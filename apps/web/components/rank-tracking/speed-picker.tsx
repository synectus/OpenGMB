"use client";
import { useTranslations } from "next-intl";
import { usd } from "../../lib/rank-tracking";

export type SpeedChoice = "standard" | "fast";
export type SpeedEstimate = { speed: SpeedChoice; estimateUsd: number; typicalMinutes: number; wouldExceed: boolean };

/** Every speed with its price for this grid, side by side; the chosen one drives the confirm button. */
export function SpeedPicker({
  speeds,
  value,
  onChange,
  name,
}: {
  speeds: SpeedEstimate[];
  value: SpeedChoice;
  onChange: (s: SpeedChoice) => void;
  name: string;
}) {
  const t = useTranslations("geogrid");
  const tc = useTranslations("geogridCost");
  if (speeds.length < 2) return null;
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm font-semibold text-foreground">{tc("speed.heading")}</legend>
      <div className="flex flex-wrap gap-2">
        {speeds.map((s) => (
          <label key={s.speed} className="flex min-h-11 items-center gap-2 rounded-control border border-border bg-card px-3 py-2 text-sm text-foreground">
            <input
              type="radio"
              name={name}
              value={s.speed}
              checked={value === s.speed}
              onChange={() => onChange(s.speed)}
              className="accent-primary"
            />
            {tc("speed.option", { name: tc(`speed.${s.speed}`), price: usd(s.estimateUsd, t), minutes: s.typicalMinutes })}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
