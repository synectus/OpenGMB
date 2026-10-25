"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { geogrid_preview, geogrid_quickScans_create } from "../../app/_generated/actions";
import { checkPlaceId } from "../../lib/quick-scan";
import { geogridHref } from "../../lib/rank-tracking";
import { buttonClass, ErrorText, inputClass } from "../ui";
import { NotLiveBadge } from "./badges";
import { CostBox, previewAt, type Preview } from "./preview-and-run";
import { SpeedPicker, type SpeedChoice } from "./speed-picker";

const label = "flex flex-col gap-1 text-sm font-semibold text-foreground";
const SIZES = [3, 5, 7, 9, 11, 13];

export function QuickScanForm({ workspaces }: { workspaces: { id: string; name: string }[] }) {
  const t = useTranslations("geogrid");
  const router = useRouter();
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [business, setBusiness] = useState("");
  const [placeId, setPlaceId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [gridSize, setGridSize] = useState(5);
  const [radiusM, setRadiusM] = useState(2000);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [speed, setSpeed] = useState<SpeedChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    void geogrid_preview({ driverId: "dataforseo_standard", gridSize, keywordCount: 1 }).then(
      (r) => live && setPreview(r.ok ? (r.data as Preview) : null),
    );
    return () => {
      live = false;
    };
  }, [gridSize]);

  // Pre-selected to the org default; a pick stays while the grid size changes.
  const priced = preview ? previewAt(preview, speed ?? preview.speed) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const bad = checkPlaceId(placeId, t);
    if (bad) return setError(`INVALID_INPUT: ${bad}`);
    setPending(true);
    setError(null);
    const r = await geogrid_quickScans_create({
      workspaceId,
      businessName: business,
      placeId: placeId.trim(),
      keyword,
      speed: priced?.speed,
      gridSize,
      radiusM,
      centerLat: Number(lat),
      centerLng: Number(lng),
    });
    setPending(false);
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    const out = r.data as { scan: { id: string }; runs: { runId: string }[] };
    router.push(geogridHref({ view: "scan", config: out.scan.id, run: out.runs[0]?.runId }));
    router.refresh();
  }

  return (
    <section id="new-quick-scan" aria-label={t("scanForm.label")} className="flex flex-col gap-4 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <h2 className="font-display text-base font-bold text-foreground">{t("scanForm.heading")}</h2>
      <form aria-label={t("scanForm.label")} onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid gap-3 lg:grid-cols-2">
          <label className={label}>
            {t("scanForm.business")}
            <input value={business} onChange={(e) => setBusiness(e.target.value)} required maxLength={200} className={inputClass} />
          </label>
          <div className="flex flex-col gap-2">
            <p className="flex flex-wrap items-center gap-2 rounded-control border border-warn-border bg-warn-bg p-2 text-xs text-warn">
              <NotLiveBadge />
              {t("scanForm.noSearch")}
            </p>
            <label className={label}>
              {t("scanForm.placeId")}
              <input value={placeId} onChange={(e) => setPlaceId(e.target.value)} required placeholder={t("scanForm.placeId")} className={inputClass} />
            </label>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={label}>
            {t("scanForm.keyword")}
            <input value={keyword} onChange={(e) => setKeyword(e.target.value)} required maxLength={120} className={inputClass} />
          </label>
          <label className={label}>
            {t("scanForm.gridSize")}
            <select value={gridSize} onChange={(e) => setGridSize(Number(e.target.value))} className={inputClass}>
              {SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t("scanForm.radius")}
            <input type="number" min={100} max={50000} value={radiusM} onChange={(e) => setRadiusM(Number(e.target.value))} className={inputClass} />
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>
            {t("scanForm.lat")}
            <input value={lat} onChange={(e) => setLat(e.target.value)} required inputMode="decimal" className={inputClass} />
          </label>
          <label className={label}>
            {t("scanForm.lng")}
            <input value={lng} onChange={(e) => setLng(e.target.value)} required inputMode="decimal" className={inputClass} />
          </label>
        </div>
        <span className="text-xs text-muted-foreground">
          {t("scanForm.coordsHint")}
        </span>
        {workspaces.length > 1 && (
          <label className={label}>
            {t("scanForm.saveTo")}
            <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} className={inputClass}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex flex-wrap items-end justify-between gap-3">
          {preview && priced && (
            <div className="flex flex-col gap-2">
              <SpeedPicker speeds={preview.speeds} value={priced.speed} onChange={setSpeed} name="scan-speed" />
              <CostBox p={priced} />
            </div>
          )}
          <button type="submit" className={buttonClass} disabled={pending || !workspaceId || Boolean(priced?.wouldExceed)}>
            {t("scanForm.run")}
          </button>
        </div>
        <ErrorText message={error} />
      </form>
    </section>
  );
}
