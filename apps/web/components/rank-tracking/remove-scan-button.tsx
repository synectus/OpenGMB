"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { geogrid_configs_delete } from "../../app/_generated/actions";
import { geogridHref } from "../../lib/rank-tracking";
import { destructiveButtonClass, ErrorText } from "../ui";

/** Removes the whole scan (every run of it): there is no single-run delete. */
export function RemoveScanButton({ scanId, runCount }: { scanId: string; runCount: number }) {
  const t = useTranslations("geogrid");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    if (!window.confirm(t("scan.confirmRemove", { count: runCount }))) return;
    const r = await geogrid_configs_delete({ id: scanId });
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    router.push(geogridHref({ view: "scan" }));
    router.refresh();
  }
  return (
    <>
      <button type="button" className={destructiveButtonClass} onClick={remove}>
        {t("scan.remove")}
      </button>
      <ErrorText message={error} />
    </>
  );
}
