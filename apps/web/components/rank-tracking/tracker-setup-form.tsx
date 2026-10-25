"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { geogrid_configs_create, geogrid_locationCenter, geogrid_preview } from "../../app/_generated/actions";
import { geogridHref, SCHEDULE_LABEL } from "../../lib/rank-tracking";
import { checkCoords, parseKeywords, priceLine } from "../../lib/tracker-setup";
import { buttonClass, ErrorText, inputClass } from "../ui";
import { NotLiveNote } from "./badges";
import { CostBox, type Preview } from "./preview-and-run";

type DriverId = "dataforseo_standard" | "places_relevance";
export type DriverOption = {
  id: DriverId;
  label: string;
  isMapsRank: boolean;
  perTaskUsd: number;
  priceVerifiedOn: string;
  priceStatus: "verified" | "unverified";
};

const label = "flex flex-col gap-1 text-sm font-semibold text-foreground";
const hint = "text-xs font-normal text-muted-foreground";
const SIZES = [3, 5, 7, 9, 11, 13];

export function TrackerSetupForm({
  locations,
  drivers,
  sample,
}: {
  locations: { id: string; label: string }[];
  drivers: DriverOption[];
  /** True while rank data is sample data (no live DataForSEO connection). */
  sample: boolean;
}) {
  const t = useTranslations("geogrid");
  const router = useRouter();
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [keywordsText, setKeywordsText] = useState("");
  const [gridSize, setGridSize] = useState(7);
  const [radiusM, setRadiusM] = useState(3000);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [driverId, setDriverId] = useState<DriverId>("dataforseo_standard");
  const [placeId, setPlaceId] = useState("");
  const [schedule, setSchedule] = useState<keyof typeof SCHEDULE_LABEL>("weekly");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [centreNote, setCentreNote] = useState<string | null>(locations[0] ? t("setup.reading") : null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const kw = parseKeywords(keywordsText, t);
  const count = kw.error ? 0 : kw.keywords.length;
  const driver = drivers.find((d) => d.id === driverId) ?? null;

  // A new tracker needs no typed coordinates: take them (and the place id) from the location's
  // Google profile. Only empty fields are filled, so anything the person typed meanwhile stays.
  useEffect(() => {
    if (!locationId) return;
    let live = true;
    void geogrid_locationCenter({ locationId }).then((r) => {
      if (!live) return;
      if (!r.ok) return setCentreNote(t("setup.readFailed"));
      const c = r.data as { centerLat: number | null; centerLng: number | null; placeId: string | null; note: string | null };
      if (c.centerLat !== null && c.centerLng !== null) {
        setLat((cur) => (cur === "" ? String(c.centerLat) : cur));
        setLng((cur) => (cur === "" ? String(c.centerLng) : cur));
      }
      if (c.placeId) setPlaceId((cur) => (cur === "" ? c.placeId! : cur));
      setCentreNote(
        c.note ? t("setup.centreNoteWith", { note: c.note }) : t("setup.centreNote"),
      );
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable for the page language
  }, [locationId]);

  useEffect(() => {
    if (count === 0) return;
    let live = true;
    void geogrid_preview({ driverId, gridSize, keywordCount: count }).then(
      (r) => live && setPreview(r.ok ? (r.data as Preview) : null),
    );
    return () => {
      live = false;
    };
  }, [driverId, gridSize, count]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = kw.error ?? checkCoords(lat, lng, t);
    if (problem) return setError(`INVALID_INPUT: ${problem}`);
    setPending(true);
    setError(null);
    const r = await geogrid_configs_create({
      locationId,
      keywords: kw.keywords,
      gridSize,
      radiusM,
      centerLat: Number(lat),
      centerLng: Number(lng),
      driverId,
      schedule,
      targetPlaceId: placeId.trim() === "" ? null : placeId.trim(),
    });
    setPending(false);
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    router.push(geogridHref({ config: (r.data as { config: { id: string } }).config.id }));
  }

  return (
    <section aria-label={t("setup.panelLabel")} className="flex flex-col gap-4 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <h2 className="font-display text-base font-bold text-foreground">{t("setup.heading")}</h2>
      <form aria-label={t("setup.formLabel")} onSubmit={submit} className="flex flex-col gap-3">
        <label className={label}>
          {t("setup.location")}
          <select
            value={locationId}
            onChange={(e) => {
              setLocationId(e.target.value);
              setLat("");
              setLng("");
              setPlaceId("");
              setCentreNote(t("setup.reading"));
            }}
            className={inputClass}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          {t("setup.keywords")}
          <input value={keywordsText} onChange={(e) => setKeywordsText(e.target.value)} required className={inputClass} />
          {keywordsText.trim() !== "" && kw.error && <span className={hint}>{kw.error}</span>}
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>
            {t("setup.gridSize")}
            <select value={gridSize} onChange={(e) => setGridSize(Number(e.target.value))} className={inputClass}>
              {SIZES.map((n) => (
                <option key={n} value={n}>
                  {n} x {n}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t("setup.radius")}
            <input
              type="number"
              min={100}
              max={50000}
              value={radiusM}
              onChange={(e) => setRadiusM(Number(e.target.value))}
              className={inputClass}
            />
            <span className={hint}>{t("setup.radiusHint")}</span>
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>
            {t("setup.lat")}
            <input value={lat} onChange={(e) => setLat(e.target.value)} required inputMode="decimal" className={inputClass} />
          </label>
          <label className={label}>
            {t("setup.lng")}
            <input value={lng} onChange={(e) => setLng(e.target.value)} required inputMode="decimal" className={inputClass} />
          </label>
        </div>
        {centreNote && <span className={hint}>{centreNote}</span>}
        <label className={label}>
          {t("setup.dataSource")}
          <select value={driverId} onChange={(e) => setDriverId(e.target.value as DriverId)} className={inputClass}>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          <span>
            {t("setup.placeId")} <span className={hint}>{t("setup.placeIdHint")}</span>
          </span>
          <input
            value={placeId}
            onChange={(e) => setPlaceId(e.target.value)}
            required={driverId === "places_relevance"}
            className={inputClass}
          />
        </label>
        <label className={label}>
          {t("setup.schedule")}
          <select
            value={schedule}
            onChange={(e) => setSchedule(e.target.value as keyof typeof SCHEDULE_LABEL)}
            className={inputClass}
          >
            {Object.keys(SCHEDULE_LABEL).map((v) => (
              <option key={v} value={v}>
                {t(`schedule.${v}`)}
              </option>
            ))}
          </select>
        </label>
        {count > 0 && preview && <CostBox p={preview} priceLine={driver ? priceLine(driver, t) : undefined} />}
        <ErrorText message={error} />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className={buttonClass}
            disabled={pending || locations.length === 0 || Boolean(preview?.wouldExceed)}
          >
            {t("setup.create")}
          </button>
          {sample && <NotLiveNote>{t("notLiveRuns")}</NotLiveNote>}
        </div>
      </form>
    </section>
  );
}
