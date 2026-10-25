import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type {
  locationsList,
  membersList,
  Permission,
  workspaceSettingsGet,
  workspacesList,
} from "@opengmb/core";
import { POST_LANGUAGES, roleHasPermission } from "@opengmb/core";
import { ClientRowActions } from "../../../components/client-row-actions";
import { CreateWorkspaceForm } from "../../../components/create-workspace-form";
import { TableWrap, tdClass, thClass } from "../../../components/page-parts";
import { WorkspacePostLanguage } from "../../../components/workspace-post-language";
import { SettingsShell } from "../../../components/settings/settings-shell";
import { ErrorText, Panel } from "../../../components/ui";
import { actorContextFor } from "../../../lib/auth";
import { requireUser } from "../../../lib/guard";
import { getTimeFormat } from "../../../lib/time-format-server";
import { workspaceRows, type Profile } from "../../../lib/workspaces-table";
import {
  locations_list,
  members_list,
  workspaceSettings_get,
  workspaces_list,
} from "../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

export default async function WorkspacesPage() {
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  const t = await getTranslations("workspaces");
  const can = (p: Permission) => roleHasPermission(role, p);
  const result = await workspaces_list();
  const workspaces = result.ok ? (result.data as Handler<typeof workspacesList>).workspaces : [];
  const [locs, members, settings] = await Promise.all([
    can("location:read") ? locations_list({}) : null,
    can("member:invite") ? members_list({}) : null,
    Promise.all(workspaces.map((w) => workspaceSettings_get({ workspaceId: w.id }))),
  ]);
  const profiles = Object.fromEntries(
    settings.flatMap((r) => {
      if (!r.ok) return [];
      const s = r.data as Handler<typeof workspaceSettingsGet>;
      return [[s.workspaceId, s.profile as Profile]];
    }),
  );
  const rows = workspaceRows({
    tf: await getTimeFormat(),
    workspaces,
    locations: locs?.ok ? (locs.data as Handler<typeof locationsList>).locations : [],
    members: members?.ok ? (members.data as Handler<typeof membersList>).members : null,
    profiles,
  });
  const showPeople = members?.ok === true;
  const languageOf = new Map(workspaces.map((w) => [w.id, w.defaultPostLanguage]));
  const canConfigure = can("review:configure");
  const canManage = can("workspace:manage");

  return (
    <SettingsShell
      current="/workspaces"
      role={role}
      title={t("title")}
      description={t("description")}
    >
      {!result.ok ? (
        <ErrorText message={`${result.error.code}: ${result.error.message}`} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <TableWrap>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t("caption")}</caption>
            <thead className="border-b border-border bg-muted">
              <tr>
                <th scope="col" className={thClass}>{t("client")}</th>
                <th scope="col" className={thClass}>{t("locations")}</th>
                <th scope="col" className={thClass}>{t("profile")}</th>
                <th scope="col" className={thClass}>{t("postLanguage")}</th>
                {showPeople && (
                  <th
                    scope="col"
                    className={thClass}
                    title={t("peopleHint")}
                  >
                    {t("people")}
                  </th>
                )}
                <th scope="col" className={thClass}>{t("created")}</th>
                {canManage && <th scope="col" className={thClass}>{t("manage")}</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className={tdClass}>
                    <Link
                      href={`/settings/workspace?ws=${r.id}`}
                      title={t("replySettingsFor", { name: r.name })}
                      className="font-semibold text-brand-text underline-offset-2 hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className={`${tdClass} tabular-nums`}>{r.locations}</td>
                  <td className={tdClass}>
                    {profiles[r.id] ? t(`profileName.${profiles[r.id]}`) : t("profileNotAvailable")}
                  </td>
                  <td className={tdClass}>
                    {canConfigure ? (
                      <WorkspacePostLanguage
                        workspaceId={r.id}
                        workspaceName={r.name}
                        value={languageOf.get(r.id) ?? "en"}
                        languages={POST_LANGUAGES}
                      />
                    ) : (
                      (POST_LANGUAGES.find((l) => l.code === languageOf.get(r.id))?.label ?? "English (en)")
                    )}
                  </td>
                  {showPeople && <td className={`${tdClass} tabular-nums`}>{r.people ?? 0}</td>}
                  <td className={`${tdClass} whitespace-nowrap`}>{r.created}</td>
                  {canManage && (
                    <td className={tdClass}>
                      <ClientRowActions workspaceId={r.id} name={r.name} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {can("workspace:create") && (
        <Panel title={t("createPanel")}>
          <CreateWorkspaceForm />
        </Panel>
      )}
    </SettingsShell>
  );
}
