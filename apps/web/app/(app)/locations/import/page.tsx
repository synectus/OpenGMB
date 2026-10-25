import { getTranslations } from "next-intl/server";
import type { googleConnectionsList, workspacesList } from "@opengmb/core";
import { IMPORT_MAX_LOCATIONS, roleHasPermission } from "@opengmb/core";
import { ImportLocations } from "../../../../components/import-locations";
import { LocationsHeader } from "../../../../components/locations/locations-header";
import { ChooseClient } from "../../../../components/choose-client";
import { EmptyState, ErrorText, Panel } from "../../../../components/ui";
import { actorContextFor } from "../../../../lib/auth";
import { requireUser } from "../../../../lib/guard";
import { currentScope } from "../../../../lib/scope-server";
import { googleConnections_list, workspaces_list } from "../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ ws?: string }> }) {
  const { userId } = await requireUser();
  const t = await getTranslations("locations");
  const { role } = await actorContextFor(userId);
  const canManage = roleHasPermission(role, "location:manage");
  const sp = await searchParams;
  const wsRes = await workspaces_list();
  const workspaces = wsRes.ok ? (wsRes.data as Handler<typeof workspacesList>).workspaces : [];
  const scope = await currentScope(sp.ws);
  const workspace = workspaces.find((w) => w.id === scope.onlyWorkspaceId);

  const header = <LocationsHeader view="list" ws={scope.urlWs} />;
  if (!wsRes.ok) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <ErrorText message={`${wsRes.error.code}: ${wsRes.error.message}`} />
      </div>
    );
  }
  if (!workspace && workspaces.length > 0) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <ChooseClient
          title={t("importChooseTitle")}
          text={t("chooseClientText")}
          path="/locations/import"
          workspaces={workspaces}
        />
      </div>
    );
  }
  if (!workspace || !canManage) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState title={workspace ? t("importTitle") : t("noClientTitle")}>
          {workspace ? t("askImport") : t("noClientBody")}
        </EmptyState>
      </div>
    );
  }

  const conns = await googleConnections_list();

  return (
    <div className="flex flex-col gap-5">
      {header}
      {!conns.ok ? (
        <ErrorText message={`${conns.error.code}: ${conns.error.message}`} />
      ) : (
        <Panel
          title={t("importPanelTitle")}
          description={t("importPanelDescription")}
        >
          <ImportLocations
            key={workspace.id}
            workspaceId={workspace.id}
            max={IMPORT_MAX_LOCATIONS}
            connections={(conns.data as Handler<typeof googleConnectionsList>).connections.map((c) => ({
              id: c.id,
              email: c.email,
            }))}
          />
        </Panel>
      )}
    </div>
  );
}
