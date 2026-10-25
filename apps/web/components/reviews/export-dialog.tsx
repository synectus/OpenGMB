"use client";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { EXPORT_COLUMN_OPTIONS } from "../../lib/review-filters";
import { buttonClass, secondaryButtonClass } from "../ui";

export function ExportDialog(p: {
  /** The page's current filters as [name, value] pairs (ws, loc, group, replied, from, to, rating...). */
  filters: [string, string][];
  workspaceLabel: string | null;
  maxRows: number;
}) {
  const t = useTranslations("reviews");
  const ref = useRef<HTMLDialogElement>(null);
  const [cols, setCols] = useState<string[]>(EXPORT_COLUMN_OPTIONS.filter((c) => c.on).map((c) => c.key));
  const [scope, setScope] = useState<"filters" | "year">("filters");
  const toggle = (k: string) => setCols((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]));
  return (
    <>
      <button type="button" className={secondaryButtonClass} onClick={() => ref.current?.showModal()}>
        {t("export.button")}
      </button>
      <dialog
        ref={ref}
        aria-labelledby="export-title"
        className="m-auto w-[min(520px,calc(100vw-32px))] rounded-2xl border border-border bg-card p-0 text-foreground shadow-card backdrop:bg-foreground/40"
      >
        <form
          method="get"
          action="/api/reviews/export"
          className="flex flex-col gap-3.5 p-5"
          onSubmit={() => setTimeout(() => ref.current?.close(), 0)}
        >
          <h2 id="export-title" className="font-display text-[19px] font-bold">{t("export.title")}</h2>
          <input type="hidden" name="cols" value="1" />
          <input type="hidden" name="scope" value={scope} />
          {scope === "filters" && p.filters.map(([k, v], i) => <input key={i} type="hidden" name={k} value={v} />)}
          {scope === "year" && p.filters.filter(([k]) => k === "ws").map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <fieldset className="flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1.5 text-[13px] font-semibold">{t("export.whichReviews")}</legend>
            <label className="flex items-center gap-2.5">
              <input type="radio" name="which" className="size-[18px] accent-primary" checked={scope === "filters"} onChange={() => setScope("filters")} />
              {t("export.matching")}
            </label>
            <label className="flex items-center gap-2.5">
              <input type="radio" name="which" className="size-[18px] accent-primary" checked={scope === "year"} onChange={() => setScope("year")} />
              {t("export.everything", { name: p.workspaceLabel ?? t("export.yourClients") })}
            </label>
          </fieldset>
          <fieldset className="border-0 p-0">
            <legend className="mb-2 text-[13px] font-semibold">{t("export.columns")}</legend>
            <div className="grid grid-cols-2 gap-2">
              {EXPORT_COLUMN_OPTIONS.map((c) => (
                <label key={c.key} className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" className="size-4 accent-primary" name="col" value={c.key} checked={cols.includes(c.key)} onChange={() => toggle(c.key)} />
                  {c.key === "date" ? c.label : t(`export.cols.${c.key}`)}
                </label>
              ))}
            </div>
            {cols.length === 0 && <p role="alert" className="mt-2 text-[13px] text-bad">{t("export.pickOne")}</p>}
          </fieldset>
          <p className="rounded-control border border-warn-border bg-warn-bg p-3 text-[13px] text-warn">
            {t("export.warning")}
          </p>
          <p className="text-xs text-muted-foreground">{t("export.limit", { max: p.maxRows.toLocaleString("en-US") })}</p>
          <div className="flex justify-end gap-2">
            <button type="button" className={secondaryButtonClass} onClick={() => ref.current?.close()}>{t("export.cancel")}</button>
            <button type="submit" className={buttonClass} disabled={cols.length === 0}>{t("export.download")}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
