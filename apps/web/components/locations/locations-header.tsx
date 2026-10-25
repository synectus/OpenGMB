import { useTranslations } from "next-intl";
import { TabLinks } from "../page-parts";
import { PageHeader } from "../ui";
import { viewTabs, type LocationView } from "../../lib/locations";

/** The header every /locations view shares: title, page actions and the view tabs. */
export function LocationsHeader({
  view,
  ws,
  alerts,
}: {
  view: LocationView;
  ws?: string;
  alerts?: number | null;
}) {
  const t = useTranslations("locations");
  const tabs = viewTabs(view, { ws, alerts }).map((v) => ({
    ...v,
    label: `${t(v.key === "bulk-edit" ? "view_bulkEdit" : `view_${v.key}`)}${v.key === "alerts" && alerts != null ? ` (${alerts})` : ""}`,
  }));
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("title")}
        description={t("description")}
      />
      <TabLinks label={t("viewsLabel")} items={tabs} />
    </div>
  );
}
