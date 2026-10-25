import Link from "next/link";
import type { aiVoiceGet, workspaceSettingsGet, workspacesList } from "@opengmb/core";
import { roleHasPermission } from "@opengmb/core";
import { getTranslations } from "next-intl/server";
import { AiUsagePanel } from "../../../../components/ai/ai-usage-panel";
import { AiVoiceForm } from "../../../../components/ai/ai-voice-form";
import { ChooseClient } from "../../../../components/choose-client";
import { SettingsShell } from "../../../../components/settings/settings-shell";
import { ErrorText, linkClass } from "../../../../components/ui";
import { WorkspaceSenderForm } from "../../../../components/workspace-sender-form";
import { WorkspaceTimeForm } from "../../../../components/workspace-time-form";
import { WorkspaceSettingsForm } from "../../../../components/workspace-settings-form";
import { actorContextFor } from "../../../../lib/auth";
import { requireUser } from "../../../../lib/guard";
import { currentScope } from "../../../../lib/scope-server";
import { aiVoice_get, workspaceSettings_get, workspaces_list } from "../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Settings = Handler<typeof workspaceSettingsGet>;
type Voice = Handler<typeof aiVoiceGet>;

export default async function ReplySettingsPage({ searchParams }: { searchParams: Promise<{ ws?: string }> }) {
  const t = await getTranslations("settings");
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  const scope = await currentScope((await searchParams).ws);
  const wsResult = await workspaces_list();
  const workspaces = wsResult.ok ? (wsResult.data as Handler<typeof workspacesList>).workspaces : [];
  const selected = workspaces.find((w) => w.id === scope.onlyWorkspaceId);
  const [settings, voice, others] = await Promise.all([
    selected ? workspaceSettings_get({ workspaceId: selected.id }) : null,
    selected ? aiVoice_get({ workspaceId: selected.id }) : null,
    Promise.all(
      workspaces
        .filter((w) => w.id !== selected?.id)
        .map((w) => workspaceSettings_get({ workspaceId: w.id })),
    ),
  ]);
  const otherRules = others.flatMap((r) => (r.ok ? [(r.data as Settings).autoApproveMinStars] : []));

  return (
    <SettingsShell
      current="/settings/workspace"
      role={role}
      title={t("workspace.title")}
      description={t("workspace.description")}
    >
      {!wsResult.ok && <ErrorText message={`${wsResult.error.code}: ${wsResult.error.message}`} />}
      {wsResult.ok && workspaces.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t.rich("workspace.noClients", {
            link: (chunks) => (
              <Link href="/workspaces" className={linkClass}>
                {chunks}
              </Link>
            ),
          })}
        </p>
      )}
      {selected && (
        <p className="text-sm">{t("workspace.settingsFor", { name: selected.name })}</p>
      )}
      {!selected && workspaces.length > 0 && (
        <ChooseClient
          title={t("workspace.chooseTitle")}
          text={t("workspace.chooseText")}
          path="/settings/workspace"
          workspaces={workspaces}
        />
      )}
      {selected && (
        <WorkspaceTimeForm
          key={`${selected.timeZone}|${selected.dateFormat}`}
          workspaceId={selected.id}
          workspaceName={selected.name}
          timeZone={selected.timeZone}
          dateFormat={selected.dateFormat}
          derived={selected.timeZoneSource === "derived"}
          canConfigure={roleHasPermission(role, "review:configure")}
        />
      )}
      {selected && (
        <WorkspaceSenderForm
          key={JSON.stringify([selected.senderLegalName, selected.senderPostalAddress, selected.senderCompanyNumber, selected.senderPhone, selected.senderWebsite, selected.hipaaCoveredEntity])}
          workspaceId={selected.id}
          workspaceName={selected.name}
          initial={selected}
          canConfigure={roleHasPermission(role, "review:configure")}
        />
      )}
      {settings &&
        (settings.ok ? (
          <WorkspaceSettingsForm
            key={JSON.stringify(settings.data)}
            initial={settings.data as Settings}
            otherRules={otherRules}
            canConfigure={roleHasPermission(role, "review:configure")}
          />
        ) : (
          <ErrorText message={`${settings.error.code}: ${settings.error.message}`} />
        ))}
      {selected && voice?.ok && (
        <AiVoiceForm
          key={JSON.stringify(voice.data)}
          workspaceId={selected.id}
          workspaceName={selected.name}
          initial={voice.data as Voice}
          canEdit={roleHasPermission(role, "review:draft")}
        />
      )}
      {roleHasPermission(role, "review:configure") && (
        <AiUsagePanel workspaceId={selected?.id} workspaceName={selected?.name} />
      )}
    </SettingsShell>
  );
}
