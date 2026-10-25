import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { locationGroupsList, locationsList, profileChangesList } from "@opengmb/core";
import { roleHasPermission, integrationEnv } from "@opengmb/core";
import { AlertFilters } from "../../../../components/alerts/alert-filters";
import { AlertsInbox } from "../../../../components/alerts/alerts-inbox";
import { LocationsHeader } from "../../../../components/locations/locations-header";
import { secondaryButtonClass } from "../../../../components/ui";
import { activity, alertsHref, hasNarrowing, listInput, parseAlertFilters } from "../../../../lib/alerts";
import { actorContextFor } from "../../../../lib/auth";
import { statusPills } from "../../../../lib/changes";
import { requireUser } from "../../../../lib/guard";
import { liveStatus } from "../../../../lib/live-status";
import { pushFacts } from "../../../../lib/push-facts";
import { scopeFilter } from "../../../../lib/scope";
import { showGroupFacet } from "../../../../lib/scope-pages";
import { currentScope } from "../../../../lib/scope-server";
import { getTimeFormat } from "../../../../lib/time-format-server";
import { locationGroups_list, locations_list, profile_changes_list } from "../../../_generated/actions";
import { EmptyNext } from "../../../../components/empty-next";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Listed = Handler<typeof profileChangesList>;

export default async function AlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { userId } = await requireUser();
  const t = await getTranslations("locations");
  const { role } = await actorContextFor(userId);
  const canEdit = roleHasPermission(role, "profile:edit");
  const live = liveStatus(integrationEnv(), false, await pushFacts()).rows;
  const writesOff = live.find((r) => r.key === "writes")?.state === "off";
  const pubsubLive = live.find((r) => r.key === "pubsub")?.state === "live";
  const sp = await searchParams;
  const scope = await currentScope(sp.ws);
  const tf = await getTimeFormat(scope.urlWs);
  // ws stays an AlertFilters facet only to carry a deep link in alertsHref; the scope, not f.ws, narrows the lists.
  const parsed = parseAlertFilters({ ...sp, ws: undefined });
  // Under a group scope the Group facet is hidden, so a stale ?group= cannot contradict the scope.
  const f = { ...parsed, group: showGroupFacet(scope) ? parsed.group : null, ws: scope.urlWs && scope.urlWs !== "all" ? scope.urlWs : null };
  const q = { ...f, ws: null };
  const fromScope = {
    ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
    ...(scope.kind === "group" && !f.loc && !f.group ? { groupId: scope.groupId! } : {}),
    ...(scope.kind === "location" && !f.loc ? { locationId: scope.locationId! } : {}),
  };
  const inScope = scope.workspaceId ? { workspaceId: scope.workspaceId } : {};
  const [r, openR, recent, locs, groups] = await Promise.all([
    profile_changes_list({ ...fromScope, ...listInput(q) }),
    f.status === "open" ? null : profile_changes_list({ ...fromScope, ...listInput(q, { status: "open", limit: 1 }) }),
    profile_changes_list({ ...fromScope, limit: 200 }),
    locations_list(scopeFilter(scope)),
    locationGroups_list(inScope),
  ]);
  const data = r.ok ? (r.data as Listed) : null;
  const openTotal = f.status === "open" ? (data?.total ?? 0) : openR?.ok ? (openR.data as Listed).total : 0;
  const locations = locs.ok ? (locs.data as Handler<typeof locationsList>).locations : [];
  const lines = recent.ok ? activity((recent.data as Listed).changes, { writesOff }, tf) : [];

  return (
    <div className="flex flex-col gap-5">
      <LocationsHeader view="alerts" ws={scope.urlWs} alerts={openTotal} />
      <p className="max-w-3xl text-sm text-muted-foreground">
        {t("alertsIntro")}
      </p>
      <nav aria-label={t("statusLabel")} className="flex flex-wrap gap-2">
        {statusPills(openTotal).map((p) => (
          <Link key={p.key} href={alertsHref(f, { status: p.key })} aria-current={p.key === f.status ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
              p.key === f.status ? "border-brand/40 bg-brand-tint font-bold" : "border-input bg-card font-medium"
            }`}>
            {t(`pill_${p.key}`, { count: openTotal })}
          </Link>
        ))}
      </nav>
      <AlertFilters
        showGroup={showGroupFacet(scope)}
        filters={f}
        locations={locations.map((l) => ({ id: l.id, name: l.name }))}
        groups={groups.ok ? (groups.data as Handler<typeof locationGroupsList>).groups.map((g) => ({ id: g.id, name: g.name })) : []}
      />
      {!pubsubLive && (
        <p className="flex flex-wrap items-center gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-[13px] text-warn">
          <span className="rounded-full border border-warn-border px-2 text-xs font-bold">{t("notLive")}</span>
          {t("pubsubNote")}
        </p>
      )}
      {!canEdit && <p className="text-sm text-muted-foreground">{t("askOwnerChanges")}</p>}

      {!r.ok ? (
        <p role="alert" className="text-[13px] text-bad"><span className="font-mono">{r.error.code}</span>: {r.error.message}</p>
      ) : data!.changes.length === 0 ? (
        hasNarrowing(q) ? (
          <div className="flex flex-col items-center gap-2 rounded-panel border border-dashed border-input bg-card px-6 py-10 text-center">
            <strong className="font-display">{t("noChangesMatch")}</strong>
            <Link href={alertsHref({ ...parseAlertFilters({ status: f.status }), ws: f.ws })} className={secondaryButtonClass}>{t("clearFilters")}</Link>
          </div>
        ) : (
          <EmptyNext id="alerts" />
        )
      ) : (
        <>
          <AlertsInbox filters={f} changes={data!.changes} pubsubLive={pubsubLive} />
          {data!.total > data!.changes.length && (
            <p className="text-xs text-muted-foreground">{t("showingNewest", { shown: data!.changes.length, total: data!.total })}</p>
          )}
        </>
      )}

      {lines.length > 0 && (
        <section aria-label={t("activity")} className="flex flex-col gap-2">
          <h2 className="font-display text-lg font-bold">{t("activity")}</h2>
          <ol className="flex flex-col gap-2">
            {lines.map((a) => (
              <li key={a.id} className="flex gap-2 text-[13px]">
                <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-brand" />
                <div className="flex flex-col">
                  <span><span className="tabular-nums text-muted-foreground">{a.time}</span> · {a.text}</span>
                  {a.note && <span className="text-xs text-muted-foreground">{a.note}</span>}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
      <p className="text-xs text-muted-foreground">{t("noAutoRestore")}</p>
    </div>
  );
}
