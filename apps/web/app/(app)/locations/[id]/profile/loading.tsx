import { LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";

/** Shown inside the location layout (header and tabs stay) while profile.get reads Google. */
export default function Loading() {
  const t = useTranslations("profile");
  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="flex items-center gap-2 rounded-lg bg-info-bg px-3 py-2 text-sm font-semibold text-info">
        <LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" />
        {t("readingProfile")}
      </p>
      <div aria-hidden className="flex flex-col gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-panel bg-muted" />
        ))}
      </div>
    </div>
  );
}
