import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { locationsHealthcheck } from "@opengmb/core";
import { HEALTHCHECK_CONFIG, emailConfigured, roleHasPermission } from "@opengmb/core";
import { CheckRow } from "../../../../../components/health/check-row";
import { SkipCheckButton } from "../../../../../components/health/skip-check-button";
import { RunAgainButton } from "../../../../../components/health/run-again-button";
import { ErrorText, Panel, secondaryButtonClass } from "../../../../../components/ui";
import { actorContextFor, currentViewAs } from "../../../../../lib/auth";
import { requireUser } from "../../../../../lib/guard";
import {
  GROUPS,
  SHOW_PILLS,
  parseShow,
  scoreTone,
  showCounts,
  visibleChecks,
  type CheckRow as Row,
} from "../../../../../lib/health";
import { isUuid } from "../../../../../lib/locations";
import { getTimeFormat } from "../../../../../lib/time-format-server";
import { locations_healthcheck, onboarding_get, onboarding_update } from "../../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
const RING = { good: "stroke-good", warn: "stroke-warn", bad: "stroke-bad" } as const;
const C = 2 * Math.PI * 42;

export default async function LocationHealthPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ show?: string }>;
}) {
  const { userId } = await requireUser();
  const t = await getTranslations("locationHub.health");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const show = parseShow((await searchParams).show);
  const { role } = await actorContextFor(userId);
  const canManage = roleHasPermission(role, "location:manage");

  const r = await locations_healthcheck({ locationId: id });
  if (!r.ok) {
    if (r.error.code === "NOT_FOUND") notFound();
    return <ErrorText message={`${r.error.code}: ${r.error.message}`} />;
  }
  const h = r.data as Handler<typeof locationsHealthcheck>;
  // First-run checklist: opening a health report is the step. Read first so a repeat view writes and audits nothing.
  // Not while a platform admin is viewing this account read-only: opening the page must not tick the customer's checklist.
  if (canManage && !(await currentViewAs())) {
    const o = await onboarding_get({});
    if (o.ok && !(o.data as { healthReportSeen: boolean }).healthReportSeen) await onboarding_update({ healthReportSeen: true });
  }
  const tf = await getTimeFormat();
  const ws = h.location.workspaceId;
  const checks: Row[] = h.checks;
  const counts = showCounts(checks);
  const failingNecessary = checks.filter((c) => c.importance === "necessary" && c.status === "fail").length;
  const tone = scoreTone(h.score.percent);
  const visible = visibleChecks(checks, show);
  const unknown = checks.some((c) => c.status === "unknown");

  return (
    <div className="flex flex-col gap-5">
      <section aria-label={t("scoreAria")} className="flex flex-wrap items-center gap-6 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
        <svg viewBox="0 0 100 100" className="size-28 -rotate-90" aria-hidden>
          <circle cx="50" cy="50" r="42" fill="none" strokeWidth="10" className="stroke-border" />
          <circle cx="50" cy="50" r="42" fill="none" strokeWidth="10" strokeLinecap="round" className={RING[tone]} strokeDasharray={`${((C * h.score.percent) / 100).toFixed(1)} ${C.toFixed(1)}`} />
        </svg>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-display text-[28px] font-extrabold tabular-nums text-foreground">{h.score.percent}%</span>
          <span className="text-sm font-semibold text-foreground">{failingNecessary > 0
              ? t("scoreLineNecessary", { passed: h.score.passed, total: h.score.total, failing: failingNecessary })
              : t("scoreLine", { passed: h.score.passed, total: h.score.total })}</span>
          <span className="text-xs text-muted-foreground">{t("checked", { when: tf.dateTime(h.checkedAt, ws) })}</span>
          <p className="max-w-xl text-sm text-muted-foreground">
            {t("intro")}
          </p>
          {unknown && <p className="text-xs text-muted-foreground">{t("unknownLeftOut")}</p>}
        </div>
        <div className="flex flex-col items-start gap-2">
          <RunAgainButton title={t("checking")} detail={t("reading", { name: h.location.name })} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled className={secondaryButtonClass}>
              {t("emailFailing")}
            </button>
            <span className="rounded-full bg-warn-bg px-2 py-0.5 text-xs font-semibold text-warn">{t("notLive")}</span>
          </div>
          {!emailConfigured() && <p className="text-xs text-muted-foreground">{t("emailNotSetUp")}</p>}
        </div>
      </section>


      <nav aria-label={t("showAria")} className="flex flex-wrap gap-2">
        {SHOW_PILLS.map((p) => (
          <Link
            key={p.key}
            href={p.key === "all" ? `/locations/${id}/health` : `/locations/${id}/health?show=${p.key}`}
            aria-current={p.key === show ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
              p.key === show ? "border-brand bg-brand-tint font-semibold text-foreground" : "border-input bg-card text-foreground hover:bg-muted"
            }`}
          >
            {t(`pill.${p.key}`)} ({counts[p.key]})
          </Link>
        ))}
      </nav>

      {GROUPS.map((g) => {
        const all = checks.filter((c) => c.importance === g.importance);
        const rows = visible.filter((c) => c.importance === g.importance);
        if (rows.length === 0) return null;
        return (
          <Panel key={g.importance} title={t("groupTitle", { title: t(`group.${g.importance}`), count: all.length })}>
            <ul className="-mx-(--panel-p) flex flex-col divide-y divide-border">
              {rows.map((c) => (
                <CheckRow
                  key={c.id}
                  c={c}
                  canManage={canManage}
                  tf={tf}
                  ws={ws}
                  action={<SkipCheckButton locationId={id} checkId={c.id} title={c.title} skipped={c.status === "skipped"} />}
                />
              ))}
            </ul>
          </Panel>
        );
      })}
      {visible.length === 0 && <p className="text-sm text-muted-foreground">{t("none")}</p>}

      <p className="text-xs text-muted-foreground">{t("thresholds", {
          photos: HEALTHCHECK_CONFIG.minPhotos,
          photoDays: HEALTHCHECK_CONFIG.recentPhotoDays,
          postDays: HEALTHCHECK_CONFIG.recentPostDays,
          rating: HEALTHCHECK_CONFIG.minAverageRating.toFixed(1),
        })}</p>
    </div>
  );
}
