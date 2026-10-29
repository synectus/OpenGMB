"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { alertsHref, FIELD_GROUPS, SOURCES, type AlertFilters, type FieldGroup } from "../../lib/alerts";
import { locationLabel } from "../../lib/locations";
import { filterFieldClass } from "../page-parts";

type Opt = { id: string; name: string };
type LocOpt = Opt & { addressSummary?: string | null; phone?: string | null };

/** `showGroup` is false under a group scope: the scope already names the group. */
export function AlertFilters({ filters, locations, groups, showGroup = true }: { filters: AlertFilters; locations: LocOpt[]; groups: Opt[]; showGroup?: boolean }) {
  const t = useTranslations("locations");
  const router = useRouter();
  const go = (patch: Partial<AlertFilters>) => router.push(alertsHref(filters, patch));
  const sel = `${filterFieldClass} rounded-md`;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
        {t("source")}
        <select className={sel} value={filters.source} onChange={(e) => go({ source: e.target.value as AlertFilters["source"] })}>
          <option value="all">{t("allSources")}</option>
          {Object.keys(SOURCES).map((k) => <option key={k} value={k}>{t(k === "google" ? "sourceGoogle" : "sourceSnapshot")}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
        {t("field")}
        <select className={sel} value={filters.field} onChange={(e) => go({ field: e.target.value as AlertFilters["field"] })}>
          <option value="all">{t("allFields")}</option>
          {Object.keys(FIELD_GROUPS).map((k) => <option key={k} value={k}>{t(`field_${k as FieldGroup}`)}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
        {t("colLocation")}
        <select className={sel} value={filters.loc ?? ""} onChange={(e) => go({ loc: e.target.value || null })}>
          <option value="">{t("allLocations")}</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{locationLabel(l)}</option>)}
        </select>
      </label>
      {showGroup && <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
        {t("group")}
        <select className={sel} value={filters.group ?? ""} onChange={(e) => go({ group: e.target.value || null })}>
          <option value="">{t("allGroups")}</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </label>}
    </div>
  );
}
