import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { replyTemplatesList, workspaceSettingsGet, workspacesList } from "@opengmb/core";
import { roleHasPermission } from "@opengmb/core";
import { ChooseClient } from "../../../../components/choose-client";
import { ReplyTemplatesManager } from "../../../../components/reply-templates-manager";
import { SettingsShell } from "../../../../components/settings/settings-shell";
import { ErrorText, linkClass } from "../../../../components/ui";
import { actorContextFor } from "../../../../lib/auth";
import { requireUser } from "../../../../lib/guard";
import { currentScope } from "../../../../lib/scope-server";
import { replyTemplates_list, workspaceSettings_get, workspaces_list } from "../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ ws?: string }> }) {
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  const t = await getTranslations("settingsTeam.templates");
  const scope = await currentScope((await searchParams).ws);
  const wsResult = await workspaces_list();
  const workspaces = wsResult.ok ? (wsResult.data as Handler<typeof workspacesList>).workspaces : [];
  const selected = workspaces.find((w) => w.id === scope.onlyWorkspaceId);
  const [list, settings] = selected
    ? await Promise.all([
        replyTemplates_list({ workspaceId: selected.id }),
        workspaceSettings_get({ workspaceId: selected.id }),
      ])
    : [null, null];
  const genericOnly =
    settings?.ok === true && (settings.data as Handler<typeof workspaceSettingsGet>).genericTemplatesOnly;

  return (
    <SettingsShell
      current="/settings/templates"
      role={role}
      title={t("title")}
      description={
        selected
          ? t(genericOnly ? "descriptionSelectedGeneric" : "descriptionSelected", { name: selected.name })
          : t("descriptionNone")
      }
    >
      {!wsResult.ok && <ErrorText message={`${wsResult.error.code}: ${wsResult.error.message}`} />}
      {wsResult.ok && workspaces.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t.rich("noClients", {
            link: (chunks) => (
              <Link href="/workspaces" className={linkClass}>
                {chunks}
              </Link>
            ),
          })}
        </p>
      )}
      {selected && (
        <p className="text-sm">{t("templatesFor", { name: selected.name })}</p>
      )}
      {!selected && workspaces.length > 0 && (
        <ChooseClient
          title={t("chooseTitle")}
          text={t("chooseText")}
          path="/settings/templates"
          workspaces={workspaces}
        />
      )}
      {selected &&
        list &&
        (list.ok ? (
          <ReplyTemplatesManager
            workspaceId={selected.id}
            templates={(list.data as Handler<typeof replyTemplatesList>).templates}
            canConfigure={roleHasPermission(role, "review:configure")}
            genericOnly={genericOnly}
          />
        ) : (
          <ErrorText message={`${list.error.code}: ${list.error.message}`} />
        ))}
      {selected && (
        <Link href={`/settings/workspace${scope.urlWs ? `?ws=${scope.urlWs}` : ""}`} className={linkClass}>
          {t("replySettings")}
        </Link>
      )}
    </SettingsShell>
  );
}
