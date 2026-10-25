import { getTranslations } from "next-intl/server";
import type { monitoringOverview } from "@opengmb/core";
import { isPlatformAdmin, roleHasPermission } from "@opengmb/core";
import { TableWrap, tdClass, thClass } from "../../../../components/page-parts";
import { HealthLimits } from "../../../../components/settings/health-limits";
import { SettingsShell } from "../../../../components/settings/settings-shell";
import { EmptyState, ErrorText, Panel } from "../../../../components/ui";
import { actorContextFor, getDb } from "../../../../lib/auth";
import { requireUser } from "../../../../lib/guard";
import { getTimeFormat } from "../../../../lib/time-format-server";
import { monitoring_overview } from "../../../_generated/actions";

type Out = Awaited<ReturnType<typeof monitoringOverview.handler>>;

export default async function SystemHealthPage() {
  const t = await getTranslations("settingsStatus");
  const SOURCE: Record<Out["errors"][number]["source"], string> = {
    web: t("health.sourceWeb"),
    worker: t("health.sourceWorker"),
    mcp: t("health.sourceMcp"),
  };
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  const shell = {
    current: "/settings/health",
    role,
    title: t("health.title"),
    description: t("health.description"),
  };
  if (!roleHasPermission(role, "member:invite") || !(await isPlatformAdmin(getDb(), userId))) {
    return (
      <SettingsShell {...shell}>
        <p className="text-sm">{t("health.noAccess")}</p>
      </SettingsShell>
    );
  }
  const res = await monitoring_overview({});
  const tf = await getTimeFormat();
  if (!res.ok) {
    return (
      <SettingsShell {...shell}>
        <ErrorText message={`${res.error.code}: ${res.error.message}`} />
      </SettingsShell>
    );
  }
  const d = res.data as Out;
  const when = (iso: string | null) => (iso ? tf.dateTime(iso) : t("never"));
  const workerText =
    d.worker.state === "ok"
      ? t("health.workerRunning")
      : d.worker.state === "down"
        ? t("health.workerStopped", { minutes: String(d.worker.staleAfterMinutes) })
        : t("health.workerNone");

  return (
    <SettingsShell {...shell}>
      <Panel
        title={t("health.alertsTitle")}
        description={
          d.alertDelivery === "email"
            ? t("health.alertsEmail")
            : t("health.alertsLog")
        }
      >
        <p className="text-sm">
          {t("health.backgroundWorker")}{" "}
          <span className={d.worker.state === "down" ? "font-semibold text-bad" : "font-semibold"}>{workerText}</span>
          {d.worker.lastHeartbeatAt && (
            <span className="text-muted-foreground"> {t("health.lastSeen", { when: when(d.worker.lastHeartbeatAt) })}</span>
          )}
        </p>
      </Panel>

      <HealthLimits when={when} />

      <section aria-label={t("health.recentErrors")} className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-bold">{t("health.recentErrors")}</h2>
        {d.errors.length === 0 ? (
          <EmptyState title={t("health.noErrors")}>{t("health.noErrorsBody")}</EmptyState>
        ) : (
          <TableWrap>
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-border bg-muted">
                <tr>
                  <th scope="col" className={thClass}>{t("health.colWhat")}</th>
                  <th scope="col" className={thClass}>{t("health.colWhere")}</th>
                  <th scope="col" className={thClass}>{t("health.colTimes")}</th>
                  <th scope="col" className={thClass}>{t("health.colFirst")}</th>
                  <th scope="col" className={thClass}>{t("health.colLast")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {d.errors.map((e) => (
                  <tr key={e.fingerprint}>
                    <td className={`${tdClass} max-w-[360px] break-words`}>{e.message}</td>
                    <td className={tdClass}>{SOURCE[e.source]}</td>
                    <td className={`${tdClass} tabular-nums`}>{e.count}</td>
                    <td className={`${tdClass} tabular-nums`}>{when(e.firstSeenAt)}</td>
                    <td className={`${tdClass} tabular-nums`}>{when(e.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>

      <section aria-label={t("health.googleUsage")} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-lg font-bold">{t("health.googleUsage")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("health.googleUsageBody", {
              limit: String(d.google.limitPerMinute),
              busiest: String(d.google.busiestMinuteLastHour),
            })}
          </p>
        </div>
        {d.google.days.length === 0 ? (
          <EmptyState title={t("health.noCalls")}>{t("health.noCallsBody")}</EmptyState>
        ) : (
          <TableWrap>
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead className="border-b border-border bg-muted">
                <tr>
                  <th scope="col" className={thClass}>{t("health.colDay")}</th>
                  <th scope="col" className={thClass}>{t("health.colTotal")}</th>
                  <th scope="col" className={thClass}>{t("health.colByKind")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {d.google.days.map((day) => (
                  <tr key={day.day}>
                    <td className={`${tdClass} tabular-nums`}>{day.day}</td>
                    <td className={`${tdClass} font-semibold tabular-nums`}>{day.total}</td>
                    <td className={tdClass}>
                      {day.methods.map((m) => `${m.method} ${m.calls}`).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>
    </SettingsShell>
  );
}
