import Link from "next/link";
import { useTranslations } from "next-intl";
import { TabLinks, primaryLinkButtonClass } from "../page-parts";
import { PageHeader } from "../ui";
import { viewTabs, type LocationView } from "../../lib/locations";

/** The header every /locations view shares: title, page actions and the view tabs. */
export function LocationsHeader({
  view,
  ws,
  alerts,
  canManage,
}: {
  view: LocationView;
  ws?: string;
  alerts?: number | null;
  /** Show the "Import from Google" link (location:manage). */
  canManage?: boolean;
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
        actions={
          canManage ? (
            <Link href={`/locations/import${ws ? `?ws=${ws}` : ""}`} className={primaryLinkButtonClass}>
              {t("importFromGoogle")}
            </Link>
          ) : undefined
        }
      />
      <TabLinks label={t("viewsLabel")} items={tabs} />
    </div>
  );
}
