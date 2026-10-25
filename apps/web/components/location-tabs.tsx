"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { locationTabs } from "../lib/location-hub";

const Arrow = () => (
  <svg aria-hidden viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M7 17 17 7M8 7h9v9" />
  </svg>
);

/** Tab bar shared by every page of one location, plus jumps to that location's reviews and numbers. */
export function LocationTabs({ locationId, openChanges }: { locationId: string; openChanges: number }) {
  const pathname = usePathname();
  const t = useTranslations("locationHub.tabs");
  const elsewhere = [
    { href: `/reviews?loc=${locationId}`, label: t("reviews") },
    { href: `/performance?ws=${encodeURIComponent(`l:${locationId}`)}`, label: t("performance") },
  ];
  return (
    <nav aria-label={t("aria")} className="flex flex-wrap items-center justify-between gap-x-6 border-b border-border">
      <ul className="-mb-px flex overflow-x-auto">
        {locationTabs(locationId, pathname, openChanges).map((tab) => (
          <li key={tab.href}>
            <Link
              href={tab.href}
              aria-current={tab.current ? "page" : undefined}
              className={`inline-flex whitespace-nowrap border-b-2 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${
                tab.current
                  ? "border-brand font-semibold text-foreground"
                  : "border-transparent font-medium text-muted-foreground hover:border-input hover:text-foreground"
              }`}
            >
              {tab.key === "changes" && openChanges > 0 ? t("changesCount", { count: openChanges }) : t(tab.key)}
            </Link>
          </li>
        ))}
      </ul>
      <ul className="flex gap-4 py-2 text-sm">
        {elsewhere.map((e) => (
          <li key={e.href}>
            <Link href={e.href} className="inline-flex items-center gap-1 font-semibold text-brand-text hover:underline">
              {e.label}
              <Arrow />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
