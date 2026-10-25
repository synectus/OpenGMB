"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { reviewTopics_setAuto, reviews_classifyTopics } from "../../app/_generated/actions";
import { buttonClass, ErrorText } from "../ui";

type Done = { classified: number; unclassified: number; remaining: number; stopped: "cap" | "error" | null };

/** "Classify reviews" for one client (owner, admin, manager) and the daily automatic switch (owner, admin). */
export function TopicControls({
  workspaceId,
  pending,
  aiOn,
  autoClassify,
  canClassify,
  canConfigure,
}: {
  workspaceId: string;
  pending: number;
  aiOn: boolean;
  autoClassify: boolean;
  canClassify: boolean;
  canConfigure: boolean;
}) {
  const t = useTranslations("reviewTopics");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [auto, setAuto] = useState(autoClassify);
  const [savingAuto, setSavingAuto] = useState(false);

  async function classify() {
    setBusy(true);
    setError(null);
    setDone(null);
    const r = await reviews_classifyTopics({ workspaceId });
    setBusy(false);
    if (!r.ok) {
      setError(`${r.error.code}: ${r.error.message}`);
      return;
    }
    setDone(r.data as Done);
    router.refresh();
  }

  async function toggleAuto(enabled: boolean) {
    setSavingAuto(true);
    setError(null);
    const r = await reviewTopics_setAuto({ workspaceId, enabled });
    setSavingAuto(false);
    if (!r.ok) {
      setError(`${r.error.code}: ${r.error.message}`);
      return;
    }
    setAuto(enabled);
  }

  return (
    <div className="flex flex-col gap-2">
      {canClassify && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={buttonClass} disabled={busy || !aiOn || pending === 0} onClick={classify}>
            {busy ? t("classify.working") : t("classify.button")}
          </button>
          <span className="text-[13px] text-muted-foreground">
            {!aiOn ? t("classify.aiOff") : pending === 0 ? t("classify.upToDate") : t("classify.pending", { count: pending })}
          </span>
        </div>
      )}
      <div aria-live="polite" className="flex flex-col gap-0.5 text-[13px]">
        {done && done.classified > 0 && <span>{t("classify.done", { count: done.classified })}</span>}
        {done && done.unclassified > 0 && <span className="text-muted-foreground">{t("classify.unreadable", { count: done.unclassified })}</span>}
        {done && done.remaining > 0 && !done.stopped && <span>{t("classify.remaining", { count: done.remaining })}</span>}
        {done?.stopped === "cap" && <span className="text-warn">{t("classify.capStop")}</span>}
        {done?.stopped === "error" && <span className="text-bad">{t("classify.errorStop")}</span>}
      </div>
      <ErrorText message={error} />
      {canClassify && <p className="text-xs text-muted-foreground">{t("classify.note")}</p>}
      {canConfigure && (
        <label className="flex flex-col gap-0.5 text-[13px]">
          <span className="flex items-center gap-2 font-semibold">
            <input
              type="checkbox"
              checked={auto}
              disabled={savingAuto}
              onChange={(e) => void toggleAuto(e.target.checked)}
              className="size-4 accent-primary"
            />
            {t("auto.label")}
            <span className="font-normal text-muted-foreground">{savingAuto ? t("auto.saving") : auto ? t("auto.on") : t("auto.off")}</span>
          </span>
          <span className="pl-6 text-xs text-muted-foreground">{t("auto.help")}</span>
        </label>
      )}
    </div>
  );
}
