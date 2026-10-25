import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SYSTEM_STATUS_LOCATION_CAP, emailConfigured, isPlatformAdmin, roleHasPermission, type systemStatus, integrationEnv } from "@opengmb/core";
import { TableWrap, tdClass, thClass } from "../../../../components/page-parts";
import { SyncLocationButton } from "../../../../components/sync-location-button";
import { SettingsShell } from "../../../../components/settings/settings-shell";
import { EmptyState, ErrorText, Panel, linkClass, secondaryButtonClass } from "../../../../components/ui";
import { actorContextFor, getDb } from "../../../../lib/auth";
import { requireUser } from "../../../../lib/guard";
import { liveStatus } from "../../../../lib/live-status";
import { pushFacts } from "../../../../lib/push-facts";
import { getTimeFormat } from "../../../../lib/time-format-server";
import {
  LIVE_STATE,
  jobResultText,
  lateText,
  notLiveSummary,
  reviewsCell,
  turnsOn,
} from "../../../../lib/system-status";
import { system_status } from "../../../_generated/actions";

type Out = Awaited<ReturnType<typeof systemStatus.handler>>;
export default async function SystemStatusPage() {
  const t = await getTranslations("settingsStatus");
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  // Setting names are for platform admins only (PLATFORM_ADMIN_EMAILS); customers get plain words.
  const showSettingNames = await isPlatformAdmin(getDb(), userId);
  const canSync = roleHasPermission(role, "review:draft");
  const status = liveStatus(integrationEnv(), emailConfigured(), await pushFacts());
  const alertsLive = status.rows.find((r) => r.key === "pubsub")?.state === "live";
  const res = await system_status({});
  const tf = await getTimeFormat();
  const when = (iso: string | null, ws?: string) => (iso ? tf.dateTime(iso, ws) : t("never"));

  return (
    <SettingsShell
      current="/settings/status"
      role={role}
      title={t("status.title")}
      description={t("status.description")}
    >
      <Panel title={t("status.whatIsLive")} description={notLiveSummary(status)}>
        <ul className="divide-y divide-border">
          {status.rows.map((r) => (
            <li key={r.key} className="grid gap-x-4 gap-y-1 py-3 sm:grid-cols-[180px_130px_minmax(0,1fr)]">
              <span className="text-sm font-semibold">{r.label}</span>
              <span>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${LIVE_STATE[r.state].className}`}
                >
                  <span aria-hidden className="size-1.5 rounded-full bg-current" />
                  {LIVE_STATE[r.state].label}
                </span>
              </span>
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-foreground">{r.detail}</span>
                <span className="text-muted-foreground">{t("status.whatTurnsOn", { value: turnsOn(r, showSettingNames) })}</span>
                {showSettingNames && r.setting && (
                  <span className="text-muted-foreground">
                    {t("status.setting")} <code className="font-mono">{r.setting}</code>
                  </span>
                )}
                {r.state === "misconfigured" && (
                  <p role="alert" className="font-semibold text-bad">
                    {t("status.misconfigured")}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      {!res.ok ? (
        <ErrorText message={`${res.error.code}: ${res.error.message}`} />
      ) : (
        <>
          <section aria-label={t("status.backgroundJobs")} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-lg font-bold">{t("status.backgroundJobs")}</h2>
              <Link href="/settings/status" className={secondaryButtonClass}>
                {t("status.refresh")}
              </Link>
            </div>
            {(res.data as Out).jobs
              .filter((j) => j.late)
              .map((j) => (
                <p key={j.key} role="alert" className="rounded-control border border-bad-border bg-bad-bg px-3 py-2 text-sm text-bad">
                  {lateText(j, tf)}
                </p>
              ))}
            <TableWrap>
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-border bg-muted">
                  <tr>
                    <th scope="col" className={thClass}>{t("status.colJob")}</th>
                    <th scope="col" className={thClass}>{t("status.colSchedule")}</th>
                    <th scope="col" className={thClass}>{t("status.colLastRun")}</th>
                    <th scope="col" className={thClass}>{t("status.colResult")}</th>
                    <th scope="col" className={thClass}>{t("status.colNextRun")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(res.data as Out).jobs.map((j) => (
                    <tr key={j.key}>
                      <td className={`${tdClass} font-semibold`}>{j.label}</td>
                      <td className={tdClass}>{j.schedule}</td>
                      <td className={`${tdClass} tabular-nums`}>{when(j.lastRunAt)}</td>
                      <td className={tdClass}>
                        <span
                          className={
                            j.result === "failed" || j.late
                              ? "font-semibold text-bad"
                              : j.result === "ok" && !j.note
                                ? "font-semibold text-good"
                                : "font-semibold text-warn"
                          }
                        >
                          {j.late ? t("status.late") : jobResultText(j)}
                        </span>
                        {j.error && (
                          <p className="mt-1 text-xs text-bad">
                            <code className="font-mono">{j.error.split(": ")[0]}</code>:{" "}
                            {j.error.split(": ").slice(1).join(": ")}
                          </p>
                        )}
                      </td>
                      <td className={`${tdClass} tabular-nums`}>{when(j.nextRunAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </section>

          <section aria-label={t("status.syncByLocation")} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="font-display text-lg font-bold">{t("status.syncByLocation")}</h2>
              {!alertsLive && (
                <p className="text-sm text-muted-foreground">
                  {t("status.noInstantAlerts")}
                </p>
              )}
              {!canSync && (
                <p className="text-sm text-muted-foreground">{t("status.cannotSync")}</p>
              )}
            </div>
            {(res.data as Out).locations.length === 0 ? (
              <EmptyState
                title={t("status.noLocations")}
                action={
                  <Link href="/locations" className={linkClass}>
                    {t("status.importLocations")}
                  </Link>
                }
              />
            ) : (
              <TableWrap>
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="border-b border-border bg-muted">
                    <tr>
                      <th scope="col" className={thClass}>{t("status.colLocation")}</th>
                      <th scope="col" className={thClass}>{t("status.colReviewsSynced")}</th>
                      <th scope="col" className={thClass}>{t("status.colPerformance")}</th>
                      <th scope="col" className={thClass}>{t("status.colProfile")}</th>
                      <th scope="col" className={thClass}>
                        <span className="sr-only">{t("status.colActions")}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {(res.data as Out).locations.map((l) => {
                      const muted = l.status !== "active";
                      const bad = l.needsRelink;
                      return (
                        <tr key={l.id} className={muted ? "text-muted-foreground" : undefined}>
                          <td className={`${tdClass} font-semibold`}>{l.name}</td>
                          <td className={`${tdClass} tabular-nums ${bad ? "text-bad" : ""}`}>
                            {reviewsCell(l, tf)}
                            {l.reviewsLastStatus === "failed" && l.reviewsLastError && (
                              <p className="text-xs text-bad">
                                {t("status.lastAttemptFailed")} <code className="font-mono">{l.reviewsLastError}</code>
                              </p>
                            )}
                          </td>
                          <td className={`${tdClass} tabular-nums`}>{l.performanceDate ?? t("never")}</td>
                          <td className={`${tdClass} tabular-nums`}>{when(l.profileLastChangedAt, l.workspaceId)}</td>
                          <td className={tdClass}>
                            {l.needsRelink ? (
                              <Link href="/locations" className={linkClass}>
                                {t("status.relink")}
                              </Link>
                            ) : l.status === "active" && canSync ? (
                              <SyncLocationButton workspaceId={l.workspaceId} locationId={l.id} />
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            )}
            {(res.data as Out).truncated && (
              <p className="text-xs text-muted-foreground">{t("status.truncated", { cap: String(SYSTEM_STATUS_LOCATION_CAP) })}</p>
            )}
          </section>
        </>
      )}
    </SettingsShell>
  );
}
