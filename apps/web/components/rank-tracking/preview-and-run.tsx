"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { geogrid_preview, geogrid_run } from "../../app/_generated/actions";
import { budgetLine, costLine, usd, type CostPreview } from "../../lib/rank-tracking";
import { buttonClass, ErrorText, secondaryButtonClass } from "../ui";
import { NotLiveNote } from "./badges";
import { SpeedPicker, type SpeedChoice, type SpeedEstimate } from "./speed-picker";

export type Preview = CostPreview & { isMapsRank: boolean; speed: SpeedChoice; speeds: SpeedEstimate[] };

/** The preview as priced at one speed (the preview itself is priced at the org default). */
export function previewAt(p: Preview, speed: SpeedChoice): Preview {
  const s = p.speeds.find((x) => x.speed === speed);
  return s ? { ...p, speed, estimateUsd: s.estimateUsd, wouldExceed: s.wouldExceed } : p;
}
const fail = (r: { error: { code: string; message: string } }) => `${r.error.code}: ${r.error.message}`;

export function CostBox({ p, priceLine, isKeywordRank }: { p: Preview; priceLine?: string; isKeywordRank?: boolean }) {
  const t = useTranslations("geogrid");
  const tc = useTranslations("geogridCost");
  return (
    <div role="status" className="flex flex-col gap-1 rounded-control border border-border bg-muted p-3 text-sm">
      <strong className="text-foreground">{costLine(p, t, tc)}</strong>
      <span className="text-muted-foreground">{budgetLine(p, t, tc)}</span>
      {priceLine && <span className="text-xs text-muted-foreground">{priceLine}</span>}
      {p.wouldExceed && (
        <span role="alert" className="font-semibold text-bad">
          {tc("cost.exceed")}
        </span>
      )}
      {!p.isMapsRank && !isKeywordRank && (
        <span className="text-warn">
          {t("cost.notMapsRank")}
        </span>
      )}
    </div>
  );
}

/** "Preview cost and run": asks geogrid.preview, then Confirm run ($X) or Cancel. */
export function PreviewAndRun({
  configId,
  driverId,
  gridSize,
  keywordCount,
  label,
  sample,
}: {
  configId: string;
  driverId: "dataforseo_standard" | "places_relevance" | "dataforseo_serp";
  gridSize: number;
  keywordCount: number;
  label: string;
  /** True while rank data is sample data (no live DataForSEO connection). */
  sample: boolean;
}) {
  const t = useTranslations("geogrid");
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [speed, setSpeed] = useState<SpeedChoice | null>(null);

  async function show() {
    setError(null);
    const r = await geogrid_preview({ driverId, gridSize, keywordCount });
    if (!r.ok) return setError(fail(r));
    const data = r.data as Preview;
    setSpeed(data.speed);
    setPreview(data);
  }
  async function confirm() {
    setBusy(true);
    setError(null);
    const r = await geogrid_run({ configId, speed: priced?.speed });
    setBusy(false);
    if (!r.ok) return setError(fail(r));
    setPreview(null);
    router.refresh();
  }

  const priced = preview ? previewAt(preview, speed ?? preview.speed) : null;
  if (!preview || !priced) {
    return (
      <>
        <button type="button" className={secondaryButtonClass} onClick={show}>
          {label}
        </button>
        <ErrorText message={error} />
      </>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2">
      <SpeedPicker speeds={preview.speeds} value={priced.speed} onChange={setSpeed} name={`speed-${configId}`} />
      <CostBox p={priced} isKeywordRank={driverId === "dataforseo_serp"} />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={busy || priced.wouldExceed}
          onClick={confirm}
        >
          {t("cost.confirm", { price: usd(priced.estimateUsd, t) })}
        </button>
        <button type="button" className={secondaryButtonClass} onClick={() => setPreview(null)}>
          {t("cost.cancel")}
        </button>
      </div>
      {sample && <NotLiveNote>{t("notLiveRuns")}</NotLiveNote>}
      <ErrorText message={error} />
    </div>
  );
}
