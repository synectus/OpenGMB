"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition, type ClipboardEvent, type FormEvent } from "react";
import { locations_center_clearManual, locations_center_set } from "../../app/_generated/actions";
import { runCall } from "../post-card";
import { buttonClass, ErrorText, inputClass, secondaryButtonClass } from "../ui";
import { fieldLabelClass, h2Class, hintClass, sectionClass } from "./section";

export type MapCenter = { lat: number | null; lng: number | null; source: string | null };
const SOURCES = ["google", "places", "dataforseo", "tracker", "manual"];
const PAIR = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/;

/** Where the location sits on the map, and for owners and admins a way to set it by hand. */
export function MapPosition({ locationId, center, canEdit }: { locationId: string; center: MapCenter | null; canEdit: boolean }) {
  const t = useTranslations("profile");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [error, setError] = useState<string | null>(null);
  const manual = center?.source === "manual";
  const placed = center?.lat != null && center.lng != null;
  const source = center?.source && SOURCES.includes(center.source) ? center.source : null;

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const m = PAIR.exec(e.clipboardData.getData("text"));
    if (!m) return;
    e.preventDefault();
    setLat(m[1]!);
    setLng(m[2]!);
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const la = Number(lat);
    const ln = Number(lng);
    if (lat.trim() === "" || lng.trim() === "" || !Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
      return setError(t("map.invalid"));
    }
    setError(null);
    start(async () => {
      const r = await runCall(() => locations_center_set({ locationId, lat: la, lng: ln }) as never);
      if ("error" in r) return setError(r.error);
      setOpen(false);
      router.refresh();
    });
  }

  function useAutomatic() {
    setError(null);
    start(async () => {
      const r = await runCall(() => locations_center_clearManual({ locationId }) as never);
      if ("error" in r) return setError(r.error);
      router.refresh();
    });
  }

  return (
    <section aria-label={t("map.title")} className={sectionClass}>
      <h2 className={h2Class}>{t("map.title")}</h2>
      <p role="status" className="text-sm">
        {placed && source
          ? `${center.lat!.toFixed(5)}, ${center.lng!.toFixed(5)} — ${t(`map.source.${source}`)}`
          : t("map.notFound")}
      </p>
      <p className={hintClass}>{t("map.note")}</p>
      {canEdit && !open && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryButtonClass} onClick={() => setOpen(true)} disabled={pending}>
            {t("map.setByHand")}
          </button>
          {manual && (
            <button type="button" className={secondaryButtonClass} onClick={useAutomatic} disabled={pending}>
              {t("map.useAutomatic")}
            </button>
          )}
        </div>
      )}
      {canEdit && open && (
        <form onSubmit={save} className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <label className={`${fieldLabelClass} min-w-0 flex-1 basis-32`}>
              {t("map.lat")}
              <input
                className={inputClass}
                inputMode="decimal"
                autoComplete="off"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                onPaste={onPaste}
                placeholder="23.18150"
              />
            </label>
            <label className={`${fieldLabelClass} min-w-0 flex-1 basis-32`}>
              {t("map.lng")}
              <input className={inputClass} inputMode="decimal" autoComplete="off" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="72.63690" />
            </label>
          </div>
          <p className={hintClass}>{t("map.pasteHint")}</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={buttonClass} disabled={pending}>
              {t("map.save")}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => { setOpen(false); setError(null); }} disabled={pending}>
              {t("map.cancel")}
            </button>
          </div>
        </form>
      )}
      <ErrorText message={error} />
    </section>
  );
}
