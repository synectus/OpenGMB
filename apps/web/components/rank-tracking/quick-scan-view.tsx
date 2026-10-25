import { getTranslations } from "next-intl/server";
import Link from "next/link";
import type { geogridConfigsList, geogridRunsGet, geogridRunsList, workspacesList } from "@opengmb/core";
import {
  geogrid_configs_list,
  geogrid_runs_get,
  geogrid_runs_list,
  workspaces_list,
} from "../../app/_generated/actions";
import { scanRows, type ScanRun } from "../../lib/quick-scan";
import { geogridHref } from "../../lib/rank-tracking";
import { getTimeFormat } from "../../lib/time-format-server";
import { primaryLinkButtonClass, TableWrap, tdClass, thClass } from "../page-parts";
import { EmptyState, ErrorText } from "../ui";
import { NotLiveBadge, SampleBadge } from "./badges";
import { PreviewAndRun } from "./preview-and-run";
import { QuickScanForm } from "./quick-scan-form";
import { QuickScanResult } from "./quick-scan-result";
import { RemoveScanButton } from "./remove-scan-button";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
const err = (r: { error: { code: string; message: string } }) => `${r.error.code}: ${r.error.message}`;

export async function QuickScanView({
  scanParam,
  runParam,
  canManage,
  apiKey,
  missingKeyHint,
  sample,
}: {
  scanParam: string | undefined;
  runParam: string | undefined;
  canManage: boolean;
  apiKey: string | null;
  missingKeyHint: string;
  sample: boolean;
}) {
  const t = await getTranslations("geogrid");
  const tc = await getTranslations("geogridCost");
  const tf = await getTimeFormat();
  const [cfgRes, runsRes, wsRes] = await Promise.all([
    geogrid_configs_list({ kind: "quick_scan" }),
    geogrid_runs_list({ kind: "quick_scan", limit: 200 }),
    canManage ? workspaces_list() : Promise.resolve(null),
  ]);
  if (!cfgRes.ok) return <ErrorText message={err(cfgRes)} />;
  const scans = (cfgRes.data as Handler<typeof geogridConfigsList>).configs;
  const runs = runsRes.ok ? (runsRes.data as Handler<typeof geogridRunsList>).runs : [];
  const workspaces = wsRes?.ok ? (wsRes.data as Handler<typeof workspacesList>).workspaces : [];
  const rows = scanRows(scans, runs as ScanRun[], tf, t);

  const runId = (runParam && rows.some((r) => r.runId === runParam) ? runParam : null) ??
    rows.find((r) => r.configId === scanParam)?.runId ?? rows[0]?.runId ?? null;
  const selectedRow = rows.find((r) => r.runId === runId) ?? null;
  const scan = selectedRow ? scans.find((s) => s.id === selectedRow.configId) ?? null : null;
  const detailRes = runId ? await geogrid_runs_get({ runId }) : null;
  const detail = detailRes?.ok ? (detailRes.data as Handler<typeof geogridRunsGet>) : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-muted-foreground">
          {tc("scan.intro")}
        </p>
        {sample && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <NotLiveBadge />
            <SampleBadge />
            {t("scan.sampleNote")}
          </p>
        )}
      </div>

      {canManage && <QuickScanForm workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))} />}
      {runsRes && !runsRes.ok && <ErrorText message={err(runsRes)} />}
      {detailRes && !detailRes.ok && <ErrorText message={err(detailRes)} />}

      {rows.length === 0 ? (
        <EmptyState
          title={t("scan.emptyTitle")}
          action={
            canManage ? (
              <a href="#new-quick-scan" className={primaryLinkButtonClass}>
                {t("scan.newScan")}
              </a>
            ) : undefined
          }
        >
          {t("scan.emptyBody")}
        </EmptyState>
      ) : (
        <>
          {scan && detail && (
            <QuickScanResult
              scan={scan}
              detail={detail}
              runs={(runs as ScanRun[]).filter((r) => r.configId === scan.id)}
              canManage={canManage}
              sample={sample}
              apiKey={apiKey}
              missingKeyHint={missingKeyHint}
              tf={tf}
            />
          )}
          <section aria-label={t("scan.historyLabel")} className="flex flex-col gap-2">
            <h2 className="font-display text-base font-bold text-foreground">{t("scan.historyHeading")}</h2>
            <TableWrap>
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-muted">
                  <tr>
                    {(["business", "keyword", "grid", "averageRank", "scanned"] as const).map((h) => (
                      <th key={h} scope="col" className={thClass}>
                        {t(`scan.${h}`)}
                      </th>
                    ))}
                    {canManage && (
                      <th scope="col" className={thClass}>
                        <span className="sr-only">{t("scan.actions")}</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => {
                    const s = scans.find((x) => x.id === r.configId)!;
                    return (
                      <tr key={r.runId} className={r.runId === runId ? "bg-brand-tint" : ""}>
                        <td className={`${tdClass} font-semibold`}>{r.business}</td>
                        <td className={tdClass}>{r.keyword}</td>
                        <td className={tdClass}>{r.grid}</td>
                        <td className={`${tdClass} tabular-nums`}>{r.average}</td>
                        <td className={`${tdClass} tabular-nums`}>{r.scanned}</td>
                        {canManage && (
                          <td className={tdClass}>
                            <div className="flex flex-wrap items-center gap-2">
                              <Link
                                href={geogridHref({ view: "scan", config: r.configId, run: r.runId })}
                                className="font-semibold text-brand-text underline underline-offset-2"
                              >
                                {t("scan.details")}
                              </Link>
                              <PreviewAndRun configId={r.configId} driverId="dataforseo_standard" gridSize={s.gridSize} keywordCount={1} label={t("scan.rerun")} sample={sample} />
                              <RemoveScanButton scanId={r.configId} runCount={r.runCount} />
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            {canManage ? (
              <p className="text-xs text-muted-foreground">{t("scan.rerunNote")}</p>
            ) : (
              <p className="text-sm text-muted-foreground">{t("scan.askRun")}</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
