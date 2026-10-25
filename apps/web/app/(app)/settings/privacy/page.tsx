import type { workspacesList } from "@opengmb/core";
import { roleHasPermission } from "@opengmb/core";
import { getTranslations } from "next-intl/server";
import { ChooseClient } from "../../../../components/choose-client";
import { PrivacyData } from "../../../../components/settings/privacy-data";
import { SettingsShell } from "../../../../components/settings/settings-shell";
import { ErrorText } from "../../../../components/ui";
import { actorContextFor } from "../../../../lib/auth";
import { requireUser } from "../../../../lib/guard";
import { currentScope } from "../../../../lib/scope-server";
import { workspaces_list } from "../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

export default async function PrivacyDataPage({ searchParams }: { searchParams: Promise<{ ws?: string }> }) {
  const t = await getTranslations("settings");
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  const scope = await currentScope((await searchParams).ws);
  const wsResult = await workspaces_list();
  const workspaces = wsResult.ok ? (wsResult.data as Handler<typeof workspacesList>).workspaces : [];
  const selected = workspaces.find((w) => w.id === scope.onlyWorkspaceId);

  return (
    <SettingsShell
      current="/settings/privacy"
      role={role}
      title={t("privacy.title")}
      description={t("privacy.description")}
    >
      {!wsResult.ok && <ErrorText message={`${wsResult.error.code}: ${wsResult.error.message}`} />}
      {selected ? (
        <PrivacyData
          key={selected.id}
          workspaceId={selected.id}
          workspaceName={selected.name}
          canErase={roleHasPermission(role, "workspace:erase")}
        />
      ) : (
        workspaces.length > 0 && (
          <ChooseClient
            title={t("privacy.chooseTitle")}
            text={t("privacy.chooseText")}
            path="/settings/privacy"
            workspaces={workspaces}
          />
        )
      )}
    </SettingsShell>
  );
}
