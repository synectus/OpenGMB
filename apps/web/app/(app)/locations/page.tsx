import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { locationGroupsList, locationsList, locationsStats, workspacesList } from "@opengmb/core";
import { CHECK_IDS, roleHasPermission } from "@opengmb/core";
import { GroupsPanel } from "../../../components/locations/groups-panel";
import { LocationsHeader } from "../../../components/locations/locations-header";
import { LocationsTable, type TableRow } from "../../../components/locations/locations-table";
import { PillLinks, filterFieldClass, primaryLinkButtonClass } from "../../../components/page-parts";
import { EmptyState, ErrorText, Panel, linkClass, secondaryButtonClass } from "../../../components/ui";
import { actorContextFor } from "../../../lib/auth";
import { requireUser } from "../../../lib/guard";
import {
  SHIPPED_VIEWS,
  STATUS_FILTERS,
  filterLocations,
  isUuid,
  locationsHref,
  parseStatusFilter,
  locationsPage,
  statusCounts,
} from "../../../lib/locations";
import { parsePage } from "../../../lib/health";
import { scopeFilter } from "../../../lib/scope";
import { currentScope } from "../../../lib/scope-server";
import {
  locationGroups_list,
  locations_list,
  locations_stats,
  workspaces_list,
} from "../../_generated/actions";
import { EmptyNext } from "../../../components/empty-next";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Search = { ws?: string; status?: string; group?: string; q?: string; page?: string };

export default async function LocationsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { userId } = await requireUser();
  const t = await getTranslations("locations");
  const { role } = await actorContextFor(userId);
  const canManage = roleHasPermission(role, "location:manage");
  const sp = await searchParams;

  const wsRes = await workspaces_list();
  if (!wsRes.ok) {
    return (
      <div className="flex flex-col gap-6">
        <LocationsHeader view="list" />
        <ErrorText message={`${wsRes.error.code}: ${wsRes.error.message}`} />
      </div>
    );
  }
  const workspaces = (wsRes.data as Handler<typeof workspacesList>).workspaces;
  const scope = await currentScope(sp.ws);

  if (workspaces.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <LocationsHeader view="list" />
        <EmptyState
          title={t("noClientTitle")}
          action={
            <Link href="/workspaces" className={primaryLinkButtonClass}>
              {t("createClient")}
            </Link>
          }
        >
          {t("noClientBody")}
        </EmptyState>
      </div>
    );
  }

  const carry = scope.urlWs;
  const where = scope.kind === "all" ? t("allClients") : scope.label;
  const status = parseStatusFilter(sp.status);
  const group = isUuid(sp.group) ? sp.group : undefined;
  const q = sp.q?.slice(0, 100) ?? "";
  const importHref = `/locations/import${carry ? `?ws=${carry}` : ""}`;
  const listFilter = scopeFilter(scope);

  // The groups panel edits one client's groups, so it needs that client's full location list, not the filtered one.
  const groupsWorkspaceId = canManage ? scope.onlyWorkspaceId : null;
  const [locs, groups, clientLocs] = await Promise.all([
    locations_list(listFilter),
    locationGroups_list(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
    groupsWorkspaceId ? locations_list({ workspaceId: groupsWorkspaceId }) : Promise.resolve(null),
  ]);

  let body;
  // Stats (reviews, rating, alerts) are read for the page on screen only (H4): the filters need none.
  let pageStats: Awaited<ReturnType<typeof locations_stats>> | null = null;
  let all: Handler<typeof locationsList>["locations"] = [];
  let shown: Handler<typeof locationsList>["locations"] = [];
  let paged = locationsPage(shown, 1);
  if (locs.ok) {
    all = (locs.data as Handler<typeof locationsList>).locations;
    shown = filterLocations(all, { status, group, q });
    paged = locationsPage(shown, parsePage(sp.page));
    if (paged.rows.length > 0) pageStats = await locations_stats({ locationIds: paged.rows.map((l) => l.id) });
  }
  if (!locs.ok || !groups.ok || (pageStats && !pageStats.ok) || (clientLocs && !clientLocs.ok)) {
    const err = !locs.ok ? locs.error : !groups.ok ? groups.error : pageStats && !pageStats.ok ? pageStats.error : clientLocs && !clientLocs.ok ? clientLocs.error : null;
    body = <ErrorText message={err ? `${err.code}: ${err.message}` : null} />;
  } else {
    const groupList = (groups.data as Handler<typeof locationGroupsList>).groups;
    const statList = pageStats ? (pageStats.data as Handler<typeof locationsStats>).locations : [];
    const statById = new Map(statList.map((s) => [s.locationId, s]));
    const rows: TableRow[] = paged.rows.map((l) => ({ ...l, stats: statById.get(l.id) ?? null }));
    const counts = statusCounts(all);
    const w = paged.window;

    body =
      all.length === 0 ? (
        <EmptyNext
          id="locations"
          href={importHref}
          noLink={!canManage}
          ask={t("askImport")}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <PillLinks
              label={t("statusLabel")}
              items={STATUS_FILTERS.map((f) => ({
                href: locationsHref({ ws: carry, status: f.key, group, q }),
                label: `${t(`status_${f.key}`)} (${counts[f.key]})`,
                current: f.key === status,
              }))}
            />
            <form method="get" action="/locations" className="flex flex-wrap items-end gap-2">
              {carry && <input type="hidden" name="ws" value={carry} />}
              {status !== "all" && <input type="hidden" name="status" value={status} />}
              {scope.kind !== "group" && scope.kind !== "location" && (
                <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
                  {t("group")}
                  <select name="group" defaultValue={group ?? ""} className={filterFieldClass}>
                    <option value="">{t("allGroups")}</option>
                    {groupList.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
                <span className="sr-only">{t("searchLocations")}</span>
                <input
                  type="search"
                  name="q"
                  defaultValue={q}
                  placeholder={t("searchLocations")}
                  aria-label={t("searchLocations")}
                  className={filterFieldClass}
                />
              </label>
              <button type="submit" className={`${secondaryButtonClass} min-h-9`}>
                {t("filter")}
              </button>
            </form>
          </div>
          <p className="text-sm text-muted-foreground">
            {w.pages > 1
              ? shown.length === all.length
                ? t("rangeLine", { from: w.from, to: w.to, total: shown.length, where })
                : t("rangeLineMatching", { from: w.from, to: w.to, total: shown.length, all: all.length, where })
              : shown.length === all.length
                ? t("countLine", { count: all.length, where })
                : t("showingLine", { shown: shown.length, all: all.length, where })}
          </p>
          {shown.length === 0 ? (
            <EmptyState title={t("noMatchTitle")}>
              <Link href={locationsHref({ ws: carry })} className={linkClass}>
                {t("clearFilters")}
              </Link>
            </EmptyState>
          ) : (
            <LocationsTable rows={rows} canManage={canManage} importHref={importHref} />
          )}
          {w.pages > 1 && (
            <nav aria-label={t("pagesNav")} className="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
              {w.hasPrev ? <Link href={locationsHref({ ws: carry, status, group, q, page: w.page - 1 })} className={linkClass}>{t("prevPage")}</Link> : <span />}
              <span className="text-muted-foreground">{t("pageOf", { page: w.page, pages: w.pages })}</span>
              {w.hasNext ? <Link href={locationsHref({ ws: carry, status, group, q, page: w.page + 1 })} className={linkClass}>{t("nextPage")}</Link> : <span />}
            </nav>
          )}
          {canManage && (
            <div id="groups">
              <Panel title={t("groupsTitle")} description={t("groupsDescription")}>
                {groupsWorkspaceId && clientLocs?.ok ? (
                  <GroupsPanel
                    key={groupsWorkspaceId}
                    workspaceId={groupsWorkspaceId}
                    groups={groupList.filter((g) => g.workspaceId === groupsWorkspaceId)}
                    locations={(clientLocs.data as Handler<typeof locationsList>).locations.map((l) => ({
                      id: l.id,
                      name: l.name,
                    }))}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("pickClientGroups")}
                  </p>
                )}
              </Panel>
            </div>
          )}
          <Panel title={t("healthScoredTitle")}>
            <p className="text-sm text-muted-foreground">{t("healthScoredBody", { count: CHECK_IDS.length })}</p>
            {SHIPPED_VIEWS.has("health") && (
              <Link href={`/locations/health${carry ? `?ws=${carry}` : ""}`} className={linkClass}>
                {t("openHealth")}
              </Link>
            )}
          </Panel>
        </>
      );
  }

  return (
    <div className="flex flex-col gap-5">
      <LocationsHeader view="list" ws={carry} />
      {body}
    </div>
  );
}
