import { useTranslations } from "next-intl";

export default function Loading() {
  const t = useTranslations("performance");
  return (
    <div className="flex flex-col gap-6">
      <p className="sr-only" role="status">{t("loading")}</p>
      <div aria-hidden className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {[1, 2, 3, 4, 5].map((n) => (
          <div key={n} className="flex h-28 flex-col gap-2 rounded-panel border border-border bg-card p-4">
            <span className="h-3 w-2/3 animate-pulse rounded bg-muted" />
            <span className="h-6 w-1/2 animate-pulse rounded bg-muted" />
            <span className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
