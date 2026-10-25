import Link from "next/link";
import { useTranslations } from "next-intl";
import { Pill, StatusBadge } from "../page-parts";

export function LocationHeader({
  name,
  addressSummary,
  workspaceId,
  workspaceName,
  status,
  needsRelink,
  suspensionOpen,
}: {
  name: string;
  addressSummary: string | null;
  workspaceId: string;
  workspaceName: string;
  status: "active" | "inactive";
  needsRelink: boolean;
  suspensionOpen: boolean;
}) {
  const t = useTranslations("locationHub.header");
  return (
    <div className="flex flex-col gap-2">
      <nav aria-label={t("breadcrumb")} className="text-sm text-muted-foreground">
        <Link href={`/locations?ws=${workspaceId}`} className="font-semibold text-brand-text hover:underline">
          {t("locations")}
        </Link>
        <span aria-hidden className="px-1.5">
          ›
        </span>
        <span>{name}</span>
      </nav>
      <h1 className="font-display text-[28px] leading-[34px] font-extrabold tracking-tight text-foreground">{name}</h1>
      <p className="text-sm text-muted-foreground">{[addressSummary, workspaceName].filter(Boolean).join(" · ")}</p>
      <div className="flex flex-wrap gap-2">
        <StatusBadge status={status} />
        {needsRelink && <Pill tone="bad">{t("notLinked")}</Pill>}
        {suspensionOpen && <Pill tone="bad">{t("suspensionOpen")}</Pill>}
      </div>
    </div>
  );
}
