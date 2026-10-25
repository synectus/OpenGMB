"use client";
import { useTranslations } from "next-intl";
import {
  allPicked,
  BULK_MAX_LOCATIONS,
  capNote,
  ineligibleReason,
  quickSelect,
  toggleAllIds,
  type BulkGroup,
  type BulkLoc,
} from "../lib/bulk-edit";
import { secondaryButtonClass } from "./ui";

/** The location checkboxes with "All" and the group quick-selects. Shared by Bulk edit and Copy services. */
export function LocationPicker({
  locations,
  groups,
  picked,
  onPick,
}: {
  locations: BulkLoc[];
  groups: BulkGroup[];
  picked: string[];
  onPick: (ids: string[]) => void;
}) {
  const t = useTranslations("locationHub.picker");
  const note = capNote(locations);
  const full = picked.length >= BULK_MAX_LOCATIONS;
  return (
    <section aria-label={t("aria")} className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={allPicked(picked, locations)}
          onChange={() => onPick(toggleAllIds(picked, locations))} />
        {t("all")}
      </label>
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {locations.map((l) => {
          const on = picked.includes(l.id);
          const why = ineligibleReason(l) ?? (full && !on ? t("limitReached", { max: BULK_MAX_LOCATIONS }) : null);
          return (
            <label key={l.id} className={`flex items-center gap-2 rounded-control border px-3 py-2 text-sm ${
              why ? "border-border bg-muted text-muted-foreground" : on ? "border-brand/40 bg-brand-tint" : "border-border bg-card"
            }`}>
              <input type="checkbox" checked={on} disabled={Boolean(why)}
                onChange={() => onPick(on ? picked.filter((id) => id !== l.id) : [...picked, l.id])} />
              {l.name}
              {why && <span className="ml-auto text-xs">{why}</span>}
            </label>
          );
        })}
      </div>
      {locations.length === 0 && <p className="text-sm text-muted-foreground">{t("none")}</p>}
      {groups.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("quickSelect")}</span>
          {groups.map((g) => (
            <button key={g.id} type="button" className={`${secondaryButtonClass} min-h-8 px-3`}
              onClick={() => onPick(quickSelect(g, locations))}>
              {g.name}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
