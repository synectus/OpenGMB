"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { locations_healthcheckSkip } from "../../app/_generated/actions";

export function SkipCheckButton({
  locationId,
  checkId,
  title,
  skipped,
}: {
  locationId: string;
  checkId: string;
  title: string;
  skipped: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("locationHub.health");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const label = skipped ? t("undoSkip") : t("skip");
  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        aria-label={t("skipAria", { label, title })}
        className="text-sm font-semibold text-brand-text underline underline-offset-2 hover:text-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await locations_healthcheckSkip({ locationId, checkId, skipped: !skipped });
            if (!r.ok) setError(`${r.error.code}: ${r.error.message}`);
            router.refresh();
          })
        }
      >
        {label}
      </button>
      {error && (
        <span role="alert" className="text-xs font-medium text-bad">
          {error}
        </span>
      )}
    </span>
  );
}
