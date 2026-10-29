import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { locationGroupsList, locationsList, profileChangeSetsList, profileChangesList, workspacesList } from "@opengmb/core";
import { PROFILE_METADATA, roleHasPermission, integrationEnv } from "@opengmb/core";
import { BulkProfileEdit } from "../../../../components/bulk-profile-edit";
import { ChooseClient } from "../../../../components/choose-client";
import { LocationsHeader } from "../../../../components/locations/locations-header";
import { ProfileChangeSets } from "../../../../components/profile-change-sets";
import { EmptyState, linkClass } from "../../../../components/ui";
import { actorContextFor } from "../../../../lib/auth";
import { requireUser } from "../../../../lib/guard";
import { liveStatus } from "../../../../lib/live-status";
import { currentScope } from "../../../../lib/scope-server";
import {
  locationGroups_list,
  locations_list,
  profile_changeSets_list,
  profile_changes_list,
  workspaces_list,
} from "../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
const codeLine = (e: { code: string; message: string }) => (
  <p role="alert" className="text-[13px] text-bad"><span className="font-mono">{e.code}</span>: {e.message}</p>
);

export default async function BulkEditPage({ searchParams }: { searchParams: Promise<{ ws?: string }> }) {
  const { userId } = await requireUser();
  const t = await getTranslations("locations");
  const { role } = await actorContextFor(userId);
  const canEdit = roleHasPermission(role, "profile:edit");
  const writesOff = liveStatus(integrationEnv(), false).rows.find((r) => r.key === "writes")?.state === "off";
  const sp = await searchParams;
  const scope = await currentScope(sp.ws);
  const openAlerts = await profile_changes_list({ ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}), status: "open", limit: 1 });
  const alerts = openAlerts.ok ? (openAlerts.data as Handler<typeof profileChangesList>).total : null;
  const wsResult = await workspaces_list();

  let body;
  if (!wsResult.ok) body = codeLine(wsResult.error);
  else {
    const workspaces = (wsResult.data as Handler<typeof workspacesList>).workspaces;
    const workspace = workspaces.find((w) => w.id === scope.onlyWorkspaceId) ?? null;
    if (workspaces.length === 0) {
      body = (
        <EmptyState title={t("noClientTitle")} action={<Link href="/workspaces" className={linkClass}>{t("createAClient")}</Link>}>
          {t("bulkNoClientBody")}
        </EmptyState>
      );
    } else if (!workspace) {
      body = (
        <ChooseClient
          title={t("bulkChooseTitle")}
          text={t("chooseClientText")}
          path="/locations/bulk-edit"
          workspaces={workspaces}
        />
      );
    } else {
      const [locs, groups, sets] = await Promise.all([
        locations_list({ workspaceId: workspace.id }),
        locationGroups_list({ workspaceId: workspace.id }),
        profile_changeSets_list({ workspaceId: workspace.id }),
      ]);
      if (!locs.ok) body = codeLine(locs.error);
      else if (!groups.ok) body = codeLine(groups.error);
      else if (!sets.ok) body = codeLine(sets.error);
      else {
        const inScope = scope.kind === "group" || scope.kind === "location" ? scope.locationIds : null;
        const all = (locs.data as Handler<typeof locationsList>).locations.filter((l) => (inScope ? inScope.includes(l.id) : true));
        body = (
          <>
            {canEdit ? (
              <BulkProfileEdit
                key={workspace.id}
                workspaceId={workspace.id}
                searchMinChars={PROFILE_METADATA.searchMinChars}
                locations={all.map((l) => ({ id: l.id, name: l.name, addressSummary: l.addressSummary, phone: l.phone, status: l.status, googleLocationId: l.googleLocationId, needsRelink: l.needsRelink }))}
                groups={(groups.data as Handler<typeof locationGroupsList>).groups.map((g) => ({ id: g.id, name: g.name, locationIds: g.locationIds }))}
              />
            ) : (
              <div className="flex flex-col gap-1">
                <strong className="text-sm">{t("roleReviewOnly")}</strong>
                <span className="text-sm text-muted-foreground">{t("listStaysVisible")}</span>
              </div>
            )}
            <section id="change-sets" aria-labelledby="cs" className="flex flex-col gap-3">
              <div>
                <h2 id="cs" className="font-display text-lg font-bold">{t("profileChanges")}</h2>
                <p className="text-sm text-muted-foreground">{t("changeSetsNewest")}</p>
              </div>
              <ProfileChangeSets changeSets={(sets.data as Handler<typeof profileChangeSetsList>).changeSets} writesOff={writesOff} />
            </section>
          </>
        );
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <LocationsHeader view="bulk-edit" ws={scope.urlWs} alerts={alerts} canManage={roleHasPermission(role, "location:manage")} />
      <p className="max-w-2xl text-sm text-muted-foreground">
        {t("bulkIntro")}
      </p>
      {body}
    </div>
  );
}
