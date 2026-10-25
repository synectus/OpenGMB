"use client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { geogrid_configs_delete, geogrid_configs_update } from "../../app/_generated/actions";
import {
  geogridHref,
  gridLabel,
  usd,
  SCHEDULE_LABEL,
  sortKeywords,
  toggleFavorite,
} from "../../lib/rank-tracking";
import { linkButtonClass, Pill } from "../page-parts";
import { ErrorText, secondaryButtonClass } from "../ui";
import { DriverBadge } from "./badges";
import { PreviewAndRun } from "./preview-and-run";

export type TrackerRow = {
  id: string;
  targetName: string;
  keywords: string[];
  favoriteKeywords: string[];
  gridSize: number;
  radiusM: number;
  schedule: keyof typeof SCHEDULE_LABEL;
  active: boolean;
  competitorRefresh: keyof typeof SCHEDULE_LABEL;
  /** Null unless the role may see prices. */
  competitorRefreshEstimateUsd: number | null;
  driverId: "dataforseo_standard" | "places_relevance" | "dataforseo_serp";
  driverLabel: string;
  isMapsRank: boolean;
};

const deleteClass = secondaryButtonClass.replace("text-foreground", "text-destructive");
const fail = (r: { error: { code: string; message: string } }) => `${r.error.code}: ${r.error.message}`;

export function Star({ filled }: { filled: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`size-3.5 ${filled ? "fill-brand text-brand" : "fill-none text-muted-foreground"}`}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinejoin="round"
    >
      <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
    </svg>
  );
}

function TrackerCard({ t, selected, canManage, sample }: { t: TrackerRow; selected: boolean; canManage: boolean; sample: boolean }) {
  const tr = useTranslations("geogrid");
  const router = useRouter();
  const [favorites, setFavorites] = useState(t.favoriteKeywords);
  const [error, setError] = useState<string | null>(null);

  async function star(keyword: string) {
    const before = favorites;
    const next = toggleFavorite(before, keyword);
    setFavorites(next);
    setError(null);
    const r = await geogrid_configs_update({ id: t.id, favoriteKeywords: next });
    if (!r.ok) {
      setFavorites(before);
      return setError(fail(r));
    }
    router.refresh();
  }
  async function toggleActive() {
    setError(null);
    const r = await geogrid_configs_update({ id: t.id, active: !t.active });
    if (!r.ok) return setError(fail(r));
    router.refresh();
  }
  async function toggleCompetitorRefresh() {
    setError(null);
    const r = await geogrid_configs_update({ id: t.id, competitorRefresh: t.competitorRefresh === "manual" ? "weekly" : "manual" });
    if (!r.ok) return setError(fail(r));
    router.refresh();
  }
  async function remove() {
    if (!window.confirm(tr("trackers.confirmDelete"))) return;
    setError(null);
    const r = await geogrid_configs_delete({ id: t.id });
    if (!r.ok) return setError(fail(r));
    router.push(geogridHref({}));
    router.refresh();
  }

  return (
    <article
      aria-label={t.targetName}
      aria-current={selected ? "true" : undefined}
      className={`flex flex-col gap-2 rounded-panel border p-4 ${selected ? "border-brand bg-brand-tint" : "border-border bg-card"}`}
    >
      <strong className="font-display text-base text-foreground">{t.targetName}</strong>
      <ul aria-label={tr("trackers.keywords")} className="flex flex-wrap gap-1.5">
        {sortKeywords(t.keywords, favorites).map((k) => {
          const fav = favorites.includes(k);
          return (
            <li
              key={k}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-card py-0.5 pl-2.5 pr-1 text-xs font-semibold text-foreground"
            >
              {k}
              {canManage ? (
                <button
                  type="button"
                  aria-label={tr(fav ? "trackers.unfavorite" : "trackers.favorite", { keyword: k })}
                  onClick={() => star(k)}
                  className="inline-flex size-6 items-center justify-center rounded-full hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <Star filled={fav} />
                </button>
              ) : fav ? (
                <>
                  <Star filled />
                  <span className="sr-only">{tr("trackers.favoriteMark")}</span>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      <span className="text-sm text-muted-foreground">{gridLabel(t.gridSize, t.radiusM, tr)}</span>
      <div className="flex flex-wrap items-center gap-2">
        <Pill>{tr(`schedule.${t.schedule}`)}</Pill>
        <DriverBadge label={t.driverLabel} isMapsRank={t.isMapsRank} />
        {!t.active && <Pill>{tr("trackers.inactive")}</Pill>}
      </div>
      {canManage && (
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input type="checkbox" className="mt-1" checked={t.competitorRefresh !== "manual"} onChange={toggleCompetitorRefresh} />
          <span>
            {tr("trackers.competitorRefresh")}
            <span className="block text-xs text-muted-foreground">
              {t.competitorRefreshEstimateUsd === null
                ? tr("trackers.competitorRefreshFree")
                : tr("trackers.competitorRefreshCost", { amount: usd(t.competitorRefreshEstimateUsd) })}
            </span>
          </span>
        </label>
      )}
      <ErrorText message={error} />
      <div className="flex flex-wrap gap-2">
        <Link href={geogridHref({ config: t.id })} className={linkButtonClass}>
          {tr("trackers.open")}
        </Link>
        {canManage && t.active && (
          <PreviewAndRun
            configId={t.id}
            driverId={t.driverId}
            gridSize={t.gridSize}
            keywordCount={t.keywords.length}
            label={tr("trackers.previewAndRun")}
            sample={sample}
          />
        )}
        {canManage && (
          <>
            <button type="button" className={secondaryButtonClass} onClick={toggleActive}>
              {t.active ? tr("trackers.deactivate") : tr("trackers.activate")}
            </button>
            <button type="button" className={deleteClass} onClick={remove}>
              {tr("trackers.delete")}
            </button>
          </>
        )}
      </div>
      {canManage && <span className="text-xs text-muted-foreground">{tr("trackers.deleteNote")}</span>}
    </article>
  );
}

export function TrackerList({
  trackers,
  selectedId,
  canManage,
  sample,
}: {
  trackers: TrackerRow[];
  selectedId: string | null;
  canManage: boolean;
  sample: boolean;
}) {
  const tr = useTranslations("geogrid");
  return (
    <div className="flex flex-col gap-3">
      {trackers.map((t) => (
        <TrackerCard
          key={`${t.id}-${t.active}-${t.competitorRefresh}-${t.favoriteKeywords.join("|")}`}
          t={t}
          selected={t.id === selectedId}
          canManage={canManage}
          sample={sample}
        />
      ))}
      {!canManage && (
        <p className="text-sm text-muted-foreground">{tr("trackers.askRun")}</p>
      )}
    </div>
  );
}
