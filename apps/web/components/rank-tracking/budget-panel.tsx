"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { geogrid_settings_update } from "../../app/_generated/actions";
import { monthLine, usd } from "../../lib/rank-tracking";
import { buttonClass, ErrorText, inputClass } from "../ui";

export function BudgetPanel({
  settings,
  canEdit,
}: {
  settings: {
    monthToDateUsd: number;
    monthlyBudgetUsd: number;
    markupPercent: number;
    defaultSpeed: "standard" | "fast";
    defaultCompetitorRefresh: "manual" | "weekly";
    weeklyRefreshEstimateUsd: number;
    speeds: { speed: "standard" | "fast"; perTaskUsd: number; typicalMinutes: number }[];
    isDefault: boolean;
  };
  canEdit: boolean;
}) {
  const t = useTranslations("geogrid");
  const tc = useTranslations("geogridCost");
  const router = useRouter();
  const [budget, setBudget] = useState(String(settings.monthlyBudgetUsd));
  const [markup, setMarkup] = useState(String(settings.markupPercent));
  const [speed, setSpeed] = useState(settings.defaultSpeed);
  const [refresh, setRefresh] = useState(settings.defaultCompetitorRefresh);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const r = await geogrid_settings_update({ monthlyBudgetUsd: Number(budget), markupPercent: Number(markup), defaultSpeed: speed, defaultCompetitorRefresh: refresh });
    setPending(false);
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    router.refresh();
  }

  return (
    <section aria-label={tc("budget.panelLabel")} className="flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <h2 className="font-display text-base font-bold text-foreground">{tc("budget.heading")}</h2>
      <p className="text-sm text-foreground">{monthLine(settings, t, tc)}</p>
      {canEdit && (
        <form aria-label={tc("budget.formLabel")} onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm font-semibold">
            {tc("budget.monthly")}
            <input type="number" min={0} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} className={`w-32 ${inputClass}`} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold">
            {tc("budget.markup")}
            <input type="number" min={0} step="0.01" value={markup} onChange={(e) => setMarkup(e.target.value)} className={`w-28 ${inputClass}`} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold">
            {tc("speed.defaultLabel")}
            <select value={speed} onChange={(e) => setSpeed(e.target.value as typeof speed)} className={inputClass}>
              {settings.speeds.map((s) => (
                <option key={s.speed} value={s.speed}>
                  {tc("speed.defaultOption", { name: tc(`speed.${s.speed}`), price: `$${s.perTaskUsd.toFixed(4)}`, minutes: s.typicalMinutes })}
                </option>
              ))}
            </select>
          </label>
          <span className="basis-full text-xs font-normal text-muted-foreground">{tc("speed.defaultHint")}</span>
          <label className="flex flex-col gap-1 text-sm font-semibold">
            {tc("speed.refreshLabel")}
            <select value={refresh} onChange={(e) => setRefresh(e.target.value as typeof refresh)} className={inputClass}>
              <option value="manual">{tc("speed.refreshOff")}</option>
              <option value="weekly">{tc("speed.refreshWeekly")}</option>
            </select>
          </label>
          <span className="basis-full text-xs font-normal text-muted-foreground">
            {tc("speed.refreshHint", { amount: usd(settings.weeklyRefreshEstimateUsd) })}
          </span>
          <button type="submit" className={buttonClass} disabled={pending}>
            {t("limitForm.save")}
          </button>
        </form>
      )}
      <ErrorText message={error} />
    </section>
  );
}
