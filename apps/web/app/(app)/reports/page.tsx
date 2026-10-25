import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { locationGroupsList, reportsDefinitionsList, reportsRunsGet, reportsRunsList } from "@opengmb/core";
import { PERFORMANCE_CONFIG, emailConfigured, reportPeriodLabel, roleHasPermission } from "@opengmb/core";
import { TabLinks, linkButtonClass, primaryLinkButtonClass } from "../../../components/page-parts";
import { DefinitionsTable } from "../../../components/reports/definitions-table";
import { DeliveryHistory } from "../../../components/reports/delivery-history";
import { RefreshWhilePending } from "../../../components/reports/refresh-while-pending";
import { ReportTypes } from "../../../components/reports/report-types";
import { EmptyState, ErrorText, PageHeader } from "../../../components/ui";
import { actorContextFor } from "../../../lib/auth";
import { requireUser } from "../../../lib/guard";
import { getTimeFormat } from "../../../lib/time-format-server";
import {
  emailText, emailedText, expiryOptions, kindText, languageText, linkCell, periodText,
  runErrorHint, runErrorText, scopeText, statusWait, triggerText,
} from "../../../lib/reports";
import { locationGroups_list, reports_definitions_list, reports_runs_get, reports_runs_list } from "../../_generated/actions";
import { EmptyNext } from "../../../components/empty-next";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { userId } = await requireUser();
  const t = await getTranslations("reports");
  const { role } = await actorContextFor(userId);
  const canManage = roleHasPermission(role, "report:manage");
  const tf = await getTimeFormat();
  const history = (await searchParams).view === "history";
  const emailOn = emailConfigured();
  const [defRes, runRes, grpRes] = await Promise.all([
    reports_definitions_list({}),
    reports_runs_list({ limit: history ? 100 : 20 }),
    locationGroups_list({}),
  ]);
  const defs = defRes.ok ? (defRes.data as Handler<typeof reportsDefinitionsList>).definitions : [];
  const runs = runRes.ok ? (runRes.data as Handler<typeof reportsRunsList>).runs : [];
  const groupNames = new Map((grpRes.ok ? (grpRes.data as Handler<typeof locationGroupsList>).groups : []).map((g) => [g.id, g.name]));
  const names = new Map(defs.map((d) => [d.id, d.name]));
  const details = await Promise.all(runs.map((r) => reports_runs_get({ runId: r.id })));

  const runRows = runs.map((r, i) => {
    const d = details[i];
    const ws = defs.find((x) => x.id === r.definitionId)?.workspaceId;
    const links = d?.ok ? (d.data as Handler<typeof reportsRunsGet>).shareLinks : [];
    const name = names.get(r.definitionId) ?? t("deletedReport");
    const period = reportPeriodLabel(r.periodStart, r.periodEnd);
    return {
      id: r.id,
      workspaceId: ws,
      title: `${name} · ${period}`,
      name,
      period,
      trigger: triggerText(r, t),
      status: r.status,
      wait: statusWait(r.status, t),
      error: r.status === "failed" && r.error ? runErrorText(r.error, PERFORMANCE_CONFIG.reportPdfMaxBytes, t) : null,
      hint: r.status === "failed" && r.error ? runErrorHint(r.error, t) : null,
      emailed: emailedText(r, emailOn, tf, ws, t),
      link: linkCell(links, tf, ws, t),
    };
  });

  const historySection = (
    <section aria-label={t("deliveryHistory")} className="flex flex-col gap-3">
      <div>
        <h2 className="font-display text-base font-bold text-foreground">{t("deliveryHistory")}</h2>
        <p className="text-sm text-muted-foreground">{t("historyNote")}</p>
      </div>
      {!runRes.ok && <ErrorText message={`${runRes.error.code}: ${runRes.error.message}`} />}
      {runRows.length === 0 ? (
        <EmptyState title={t("noRunsTitle")}>{t("noRunsBody")}</EmptyState>
      ) : (
        <DeliveryHistory rows={runRows} canManage={canManage} expiryOptions={expiryOptions(PERFORMANCE_CONFIG.shareLinkMaxDays)} defaultDays={PERFORMANCE_CONFIG.shareLinkDefaultDays} />
      )}
    </section>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <>
            <Link href="/performance" className={linkButtonClass}>{t("performance")}</Link>
            {canManage && <Link href="/reports/new?type=performance" className={primaryLinkButtonClass}>{t("newReport")}</Link>}
          </>
        }
      />
      <TabLinks
        label={t("viewsLabel")}
        items={[
          { href: "/reports", label: t("title"), current: !history },
          { href: "/reports?view=history", label: t("deliveryHistory"), current: history },
        ]}
      />
      <RefreshWhilePending pending={runs.some((r) => r.status === "queued" || r.status === "running")} />
      {history ? (
        historySection
      ) : (
        <>
          <ReportTypes counts={{ performance: defs.filter((d) => d.kind === "performance").length, reviews: defs.filter((d) => d.kind === "reviews").length }} canManage={canManage} />
          <section aria-label={t("definitions")} className="flex flex-col gap-3">
            <div>
              <h2 className="font-display text-base font-bold text-foreground">{t("definitions")}</h2>
              <p className="text-sm text-muted-foreground">{t("definitionsNote")}</p>
            </div>
            {!defRes.ok && <ErrorText message={`${defRes.error.code}: ${defRes.error.message}`} />}
            {defs.length === 0 ? (
              <EmptyNext id="reports" noLink={!canManage} ask={t("askSetUp")} />
            ) : (
              <DefinitionsTable
                canManage={canManage}
                rows={defs.map((d) => ({
                  id: d.id,
                  name: d.name,
                  kind: kindText(d.kind, t),
                  scope: scopeText(d, groupNames, t),
                  period: periodText(d, tf, d.workspaceId, t),
                  language: languageText(d.language, t),
                  email: emailText(d, t),
                  emailOff: d.schedule !== "monthly",
                  emailNotLive: d.schedule === "monthly" && !emailOn,
                }))}
              />
            )}
          </section>
          {historySection}
        </>
      )}
    </div>
  );
}
