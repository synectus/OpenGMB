"use client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { geogrid_locationCenter, rankings_track } from "../../app/_generated/actions";
import { locationLabel } from "../../lib/locations";
import { geogridHref } from "../../lib/rank-tracking";
import { filterFieldClass } from "../page-parts";
import { ErrorText, secondaryButtonClass } from "../ui";

type Centre = {
  centerLat: number | null;
  centerLng: number | null;
  placeId: string | null;
  websiteDomain: string | null;
  note: string | null;
};
const fail = (r: { error: { code: string; message: string } }) => `${r.error.code}: ${r.error.message}`;

/**
 * "Track this" on a Performance keyword: starts daily Google rank checks for it at one of the locations in
 * scope. The coordinates, place id and website come from the location's Google profile (geogrid.locationCenter).
 */
export function TrackKeyword({ keyword, locations }: { keyword: string; locations: { id: string; title: string; addressSummary?: string | null; phone?: string | null }[] }) {
  const t = useTranslations("performance");
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  if (locations.length === 0) return null;

  async function track() {
    setState("busy");
    setError(null);
    const c = await geogrid_locationCenter({ locationId });
    const centre = c.ok ? (c.data as Centre) : null;
    const r = await rankings_track({
      locationId,
      keyword,
      ...(centre?.centerLat != null && centre.centerLng != null ? { centerLat: centre.centerLat, centerLng: centre.centerLng } : {}),
      targetPlaceId: centre?.placeId ?? null,
      targetDomain: centre?.websiteDomain ?? null,
    });
    if (!r.ok) {
      setState("idle");
      // A first-time tracker cannot start without coordinates: say why in plain words.
      return setError(r.error.code === "INVALID_INPUT" && centre?.centerLat == null ? t("trackFailedCentre") : fail(r));
    }
    setState("done");
  }

  if (state === "done") {
    return (
      <Link href={geogridHref({ view: "keywords" })} className="text-sm font-semibold text-brand-text underline underline-offset-2">
        {t("trackedSee")}
      </Link>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {locations.length > 1 && (
          <select
            aria-label={t("trackWhere")}
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className={filterFieldClass}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {locationLabel(l)}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={state === "busy"}
          onClick={track}
          title={t("trackNote")}
          aria-label={`${t("trackThis")}: ${keyword}`}
        >
          {state === "busy" ? t("tracking") : t("trackThis")}
        </button>
      </div>
      <ErrorText message={error} />
    </div>
  );
}
