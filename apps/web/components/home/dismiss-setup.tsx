"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { onboarding_update } from "../../app/_generated/actions";

/** Hides the first-run checklist for the whole organization (owners and admins). */
export function DismissSetup() {
  const router = useRouter();
  const t = useTranslations("home");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        className="text-sm font-semibold text-brand-text underline underline-offset-2 hover:text-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await onboarding_update({ dismissed: true });
            if (!r.ok) setError(`${r.error.code}: ${r.error.message}`);
            router.refresh();
          })
        }
      >
        {t("setup.hide")}
      </button>
      {error ? <span role="alert" className="text-xs font-medium text-bad">{error}</span> : null}
    </span>
  );
}
