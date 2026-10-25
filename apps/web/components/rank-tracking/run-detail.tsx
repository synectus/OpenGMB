import { useTranslations } from "next-intl";
import Link from "next/link";
import { Suspense } from "react";
import { growthPotentialView } from "../../lib/growth-potential";
import type { MapPoint } from "../../lib/rank-map";
import {
  adjacentScans,
  geogridHref,
  gridLabel,
  progressLine,
  rankDelta,
  runErrorParts,
} from "../../lib/rank-tracking";
import type { TimeFormat } from "../../lib/time-format";
import { ErrorText } from "../ui";
import { DriverBadge, SampleBadge } from "./badges";
import { CompetitorTable, type CompetitorRow } from "./competitor-table";
import { GrowthPotential } from "./growth-potential";
import { QuickWins } from "./quick-wins";
import { RankMap } from "./rank-map";
import { RankLegend, RankTable } from "./rank-table";
import { RefreshWhileRunning } from "./refresh-while-running";
import type { HistoryRun } from "./run-history";

export type RunDetailData = {
  run: HistoryRun;
  gridSize: number;
  points: (MapPoint & { top3: boolean })[];
  progress: { collected: number; total: number };
};

const fmt1 = (n: number | null) => (n === null ? "-" : n.toFixed(1));
const pct = (n: number | null) => (n === null ? "-" : `${Math.round(n * 100)}%`);
const navClass =
  "inline-flex min-h-(--control-h) items-center gap-1.5 rounded-control border border-input bg-card px-3 text-sm font-semibold text-foreground";

export function RunDetail({
  config,
  detail,
  runs,
  competitors,
  apiKey,
  missingKeyHint,
  tf,
}: {
  config: { id: string; workspaceId?: string; locationId: string | null; targetName: string; gridSize: number; radiusM: number };
  detail: RunDetailData;
  /** Every run of this config, newest first. */
  runs: HistoryRun[];
  competitors: CompetitorRow[];
  apiKey: string | null;
  missingKeyHint: string;
  tf: TimeFormat;
}) {
  const t = useTranslations("geogrid");
  const tc = useTranslations("geogridCost");
  const run = detail.run;
  // The run's own data source, not the server's current one: an older sample run stays labelled after a key is added.
  const sampleRun = run.dataSource !== "live";
  const { previous, next } = adjacentScans(runs, run);
  const delta = previous ? rankDelta(run.summary.averageRank, previous.summary.averageRank, t) : null;
  const progress = progressLine(run.status, detail.progress, t);
  const err = run.error ? runErrorParts(run.error) : null;
  const open = run.status === "queued" || run.status === "running";
  const done = run.status === "done";
  const dateOf = (r: HistoryRun) => tf.date(r.finishedAt ?? r.createdAt, config.workspaceId);
  const runLabel = t("run.runAt", { when: tf.dateTime(run.finishedAt ?? run.createdAt, config.workspaceId) });
  const tiles = [
    {
      label: t("run.averageRank"),
      value: done ? fmt1(run.summary.averageRank) : "-",
      was: done && previous ? t("run.wasOn", { rank: fmt1(previous.summary.averageRank), date: dateOf(previous) }) : null,
      delta: done ? delta : null,
    },
    { label: t("run.top3Share"), value: done ? pct(run.summary.top3Share) : "-", was: null, delta: null },
    { label: t("run.foundShare"), value: done ? pct(run.summary.foundShare) : "-", was: null, delta: null },
  ];
  const toneClass = { good: "text-good", bad: "text-bad", neutral: "text-muted-foreground" } as const;

  return (
    <div className="flex flex-col gap-5">
      {open && <RefreshWhileRunning />}
      <section
        aria-label={t("run.detailLabel")}
        className="flex flex-col gap-4 rounded-panel border border-border bg-card p-(--panel-p) shadow-card"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-xl font-bold text-foreground">{run.keyword}</h2>
          <span className="text-sm text-muted-foreground">
            {config.targetName} · {gridLabel(config.gridSize, config.radiusM, t)}
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          {previous ? (
            <Link href={geogridHref({ config: config.id, run: previous.id })} className={navClass}>
              <span aria-hidden>‹</span> {t("run.previous")} <span className="tabular-nums text-muted-foreground">{dateOf(previous)}</span>
            </Link>
          ) : (
            <span aria-disabled="true" title={t("run.noOlder")} className={`${navClass} opacity-50`}>
              <span aria-hidden>‹</span> {t("run.previous")}
            </span>
          )}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <strong className="tabular-nums text-foreground">{runLabel}</strong>
            <DriverBadge label={run.isMapsRank ? `${run.driverLabel} (${tc(`speed.${run.speed}`)})` : run.driverLabel} isMapsRank={run.isMapsRank} />
            {sampleRun && <SampleBadge />}
          </div>
          {next ? (
            <Link href={geogridHref({ config: config.id, run: next.id })} className={navClass}>
              {t("run.next")} <span className="tabular-nums text-muted-foreground">{dateOf(next)}</span> <span aria-hidden>›</span>
            </Link>
          ) : (
            <span aria-disabled="true" title={t("run.noNewer")} className={`${navClass} opacity-50`}>
              {t("run.next")} <span aria-hidden>›</span>
            </span>
          )}
        </div>

        {!run.isMapsRank && (
          <p role="status" className="rounded-control border border-warn-border bg-warn-bg p-3 text-sm text-warn">
            {t("cost.notMapsRank")}
          </p>
        )}
        {progress && (
          <p role="status" className="text-sm font-semibold text-info">
            {progress}
          </p>
        )}
        {err && <ErrorText message={err.code ? `${err.code}: ${err.message}` : err.message} />}

        <dl className="grid gap-3 sm:grid-cols-3">
          {tiles.map((t) => (
            <div key={t.label} className="flex flex-col gap-0.5 rounded-control border border-border bg-muted p-3">
              <dt className="text-xs font-semibold text-muted-foreground">{t.label}</dt>
              <dd className="font-display text-2xl font-extrabold tabular-nums text-foreground">{t.value}</dd>
              {t.was && (
                <dd className="text-xs text-muted-foreground">
                  {t.was}
                  {t.delta && <span className={`ml-1.5 font-semibold ${toneClass[t.delta.tone]}`}>{t.delta.label}</span>}
                </dd>
              )}
            </div>
          ))}
        </dl>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{t("run.north")}</span>
          <RankMap
            apiKey={apiKey}
            missingKeyHint={missingKeyHint}
            size={detail.gridSize}
            points={detail.points}
            targetName={config.targetName}
            runLabel={runLabel}
            sample={sampleRun}
          />
          <RankLegend points={detail.points} />
          <RankTable points={detail.points} size={detail.gridSize} targetName={config.targetName} open={apiKey === null} />
          <p className="text-xs text-muted-foreground">
            {t("run.averageNote")}
          </p>
        </div>
      </section>

      {config.locationId && done && (
        <section aria-label={t("growth.heading")} className="flex flex-col gap-2 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
          <h2 className="font-display text-base font-bold text-foreground">{t("growth.heading")}</h2>
          {sampleRun ? (
            <p className="text-sm text-muted-foreground">{growthPotentialView({ sample: true, targetName: config.targetName, points: detail.points, performance: null, t }).text}</p>
          ) : (
            <Suspense fallback={null}>
              <GrowthPotential locationId={config.locationId} targetName={config.targetName} points={detail.points} />
            </Suspense>
          )}
        </section>
      )}

      {config.locationId && (
        <section aria-label={t("quickWins.heading")} className="flex flex-col gap-2 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
          <h2 className="font-display text-base font-bold text-foreground">{t("quickWins.heading")}</h2>
          <Suspense fallback={<p className="text-sm text-muted-foreground">{t("quickWins.checking")}</p>}>
            <QuickWins locationId={config.locationId} />
          </Suspense>
        </section>
      )}

      <CompetitorTable rows={competitors} />
    </div>
  );
}
