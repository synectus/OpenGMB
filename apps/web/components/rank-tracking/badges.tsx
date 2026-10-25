import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

const chip = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold";

/** Data source chip: info for Maps rank, warning for the relevance check. */
export function DriverBadge({ label, isMapsRank }: { label: string; isMapsRank: boolean }) {
  return (
    <span
      className={`${chip} border ${isMapsRank ? "border-info-border bg-info-bg text-info" : "border-warn-border bg-warn-bg text-warn"}`}
    >
      {label}
    </span>
  );
}

export function SampleBadge() {
  const t = useTranslations("geogrid");
  return <span className={`${chip} bg-secondary text-secondary-foreground`}>{t("badge.sample")}</span>;
}

export function NotLiveBadge() {
  const t = useTranslations("geogrid");
  return <span className={`${chip} border border-warn-border bg-warn-bg text-warn`}>{t("badge.notLive")}</span>;
}

/** "Not live" chip plus one plain sentence, for places where a real run would start. */
export function NotLiveNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <NotLiveBadge />
      <span>{children}</span>
    </p>
  );
}
