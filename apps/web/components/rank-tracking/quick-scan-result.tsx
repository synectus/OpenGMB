import { useTranslations } from "next-intl";
import Link from "next/link";
import type { MapPoint } from "../../lib/rank-map";
import type { TimeFormat } from "../../lib/time-format";
import { compareScans, type ScanRun } from "../../lib/quick-scan";
import { progressLine, runErrorParts } from "../../lib/rank-tracking";
import { linkButtonClass } from "../page-parts";
import { ErrorText } from "../ui";
import { SampleBadge } from "./badges";
import { PreviewAndRun } from "./preview-and-run";
import { RankMap } from "./rank-map";
import { RankLegend, RankTable } from "./rank-table";
import { RefreshWhileRunning } from "./refresh-while-running";
import { RemoveScanButton } from "./remove-scan-button";

type Detail = {
  run: ScanRun & {
    error: string | null;
    dataSource: "fixture" | "sandbox" | "live";
    summary: { averageRank: number | null; top3Share: number | null; foundShare: number | null };
  };
  gridSize: number;
  points: MapPoint[];
  progress: { collected: number; total: number };
};

const pct = (n: number | null) => (n === null ? "-" : `${Math.round(n * 100)}%`);
const chip = "inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-bold text-secondary-foreground";

export function QuickScanResult({
  scan,
  detail,
  runs,
  canManage,
  sample,
  apiKey,
  missingKeyHint,
  tf,
}: {
  scan: { id: string; workspaceId?: string; targetName: string; gridSize: number };
  detail: Detail;
  /** Every run of this scan. */
  runs: ScanRun[];
  canManage: boolean;
  /** True while rank data is sample data, so a re-run would be too. */
  sample: boolean;
  apiKey: string | null;
  missingKeyHint: string;
  tf: TimeFormat;
}) {
  const t = useTranslations("geogrid");
  const r = detail.run;
  const sampleRun = r.dataSource !== "live";
  const done = r.status === "done";
  const open = r.status === "queued" || r.status === "running";
  const when = tf.dateTime(r.finishedAt ?? r.createdAt, scan.workspaceId);
  const progress = progressLine(r.status, detail.progress, t);
  const err = r.error ? runErrorParts(r.error) : null;
  const compare = compareScans(runs, tf, scan.workspaceId, t);
  const tone = { good: "text-good", bad: "text-bad", neutral: "text-muted-foreground" } as const;

  return (
    <section aria-label={t("scan.resultLabel")} className="flex flex-col gap-4 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      {open && <RefreshWhileRunning />}
      <h2 className="font-display text-base font-bold text-foreground">{t("scan.resultHeading")}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-foreground">
          {scan.targetName} · {r.keyword}
        </strong>
        <span className={chip}>{t("scan.prospect")}</span>
        {sampleRun && <SampleBadge />}
        <span className="text-xs text-muted-foreground">{t("scan.scannedAt", { when })}</span>
      </div>
      {progress && (
        <p role="status" className="text-sm font-semibold text-info">
          {progress}
        </p>
      )}
      {err && <ErrorText message={err.code ? `${err.code}: ${err.message}` : err.message} />}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-2">
          <RankMap
            apiKey={apiKey}
            missingKeyHint={missingKeyHint}
            size={detail.gridSize}
            points={detail.points}
            targetName={scan.targetName}
            runLabel={t("run.runAt", { when })}
            sample={sampleRun}
          />
          <RankLegend points={detail.points} />
          <RankTable points={detail.points} size={detail.gridSize} targetName={scan.targetName} open={apiKey === null} />
        </div>
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-3 gap-2 xl:grid-cols-1">
            {[
              [t("run.averageRank"), done && r.summary.averageRank !== null ? r.summary.averageRank.toFixed(1) : "-"],
              [t("run.top3Share"), done ? pct(r.summary.top3Share) : "-"],
              [t("run.foundShare"), done ? pct(r.summary.foundShare) : "-"],
            ].map(([k, v]) => (
              <div key={k} className="rounded-control border border-border bg-muted p-3">
                <dt className="text-xs font-semibold text-muted-foreground">{k}</dt>
                <dd className="font-display text-2xl font-extrabold tabular-nums text-foreground">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">{t("run.averageNote")}</p>
          {compare && (
            <div className="flex flex-col gap-1 rounded-control border border-border p-3 text-sm">
              <ul aria-label={t("scan.comparison")} className="flex flex-col gap-0.5 tabular-nums">
                {compare.lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              {compare.delta && <span className={`font-semibold ${tone[compare.delta.tone]}`}>{compare.delta.label}</span>}
              <span className="text-xs text-muted-foreground">{t("scan.lowerBetter")}</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {canManage && (
              <PreviewAndRun configId={scan.id} driverId="dataforseo_standard" gridSize={scan.gridSize} keywordCount={1} label={t("scan.rerun")} sample={sample} />
            )}
            <Link href="/locations" className={linkButtonClass}>
              {t("scan.addLocation")}
            </Link>
            {canManage && <RemoveScanButton scanId={scan.id} runCount={runs.length} />}
          </div>
          {canManage && <span className="text-xs text-muted-foreground">{t("scan.removeNote")}</span>}
          <p className="text-xs text-muted-foreground">
            {t("scan.importNote")}
          </p>
        </div>
      </div>
    </section>
  );
}
