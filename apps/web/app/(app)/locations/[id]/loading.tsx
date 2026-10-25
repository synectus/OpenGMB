import { useTranslations } from "next-intl";

export default function Loading() {
  const t = useTranslations("locationHub");
  return (
    <div role="status" aria-label={t("loading")} className="grid grid-cols-2 gap-3 lg:grid-cols-6">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-24 animate-pulse rounded-control bg-muted" />
      ))}
    </div>
  );
}
