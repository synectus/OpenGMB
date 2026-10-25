"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { secondaryButtonClass } from "../ui";

export function TryAgain() {
  const router = useRouter();
  const t = useTranslations("home");
  return (
    <button type="button" className={secondaryButtonClass} onClick={() => router.refresh()}>
      {t("tryAgain")}
    </button>
  );
}
