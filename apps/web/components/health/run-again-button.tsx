"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { secondaryButtonClass } from "../ui";

/** Re-runs the page's live checks (a server refresh) and says what is happening meanwhile. */
export function RunAgainButton({ title, detail }: { title: string; detail: string }) {
  const router = useRouter();
  const t = useTranslations("locationHub.health");
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-1">
      <button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => start(() => router.refresh())}>
        {t("runAgain")}
      </button>
      {pending && (
        <p role="status" className="text-sm text-info">
          <span className="font-semibold">{title}</span> {detail}
        </p>
      )}
    </div>
  );
}
