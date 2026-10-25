import { getTranslations } from "next-intl/server";
import { roleHasPermission, type webhooksList, type workspacesList } from "@opengmb/core";
import { Pill, TableWrap, tdClass, thClass } from "../../../../components/page-parts";
import { SettingsShell } from "../../../../components/settings/settings-shell";
import { EmptyState, ErrorText, Panel } from "../../../../components/ui";
import { CreateWebhookForm, WebhookRowActions } from "../../../../components/webhooks-manager";
import { actorContextFor } from "../../../../lib/auth";
import { requireUser } from "../../../../lib/guard";
import { getTimeFormat } from "../../../../lib/time-format-server";
import { webhooks_list, workspaces_list } from "../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

export default async function WebhooksPage() {
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  const t = await getTranslations("settingsWebhooks");
  const shell = { current: "/settings/webhooks", role, title: t("title"), description: t("description") };
  if (!roleHasPermission(role, "webhook:manage")) {
    return (
      <SettingsShell {...shell}>
        <p className="text-sm">{t("noAccess")}</p>
      </SettingsShell>
    );
  }
  const tf = await getTimeFormat();
  const [result, ws] = await Promise.all([webhooks_list({}), workspaces_list()]);
  const hooks = result.ok ? (result.data as Handler<typeof webhooksList>).webhooks : [];
  const clients = ws.ok ? (ws.data as Handler<typeof workspacesList>).workspaces : [];
  const clientName = (id: string | null) =>
    id === null ? t("list.allClients") : (clients.find((c) => c.id === id)?.name ?? t("list.allClients"));

  const lastDelivery = (d: (typeof hooks)[number]["lastDelivery"]) => {
    if (!d) return t("list.noDeliveries");
    const code = d.statusCode === null ? null : String(d.statusCode);
    const words =
      d.status === "delivered"
        ? t("delivery.delivered", { code: code ?? "" })
        : d.status === "failed"
          ? code
            ? t("delivery.failed", { code })
            : t("delivery.failedNoCode")
          : d.status === "skipped"
            ? t("delivery.skipped")
            : t("delivery.pending");
    return `${words}${d.test ? t("list.testSuffix") : ""} · ${tf.dateTime(d.at)}`;
  };

  return (
    <SettingsShell {...shell}>
      <Panel title={t("form.formLabel")}>
        <CreateWebhookForm clients={clients.map((c) => ({ id: c.id, name: c.name }))} />
      </Panel>

      {!result.ok ? (
        <ErrorText message={`${result.error.code}: ${result.error.message}`} />
      ) : hooks.length === 0 ? (
        <EmptyState title={t("list.empty")}>{t("list.emptyBody")}</EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          <TableWrap>
            <table className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">{t("list.caption")}</caption>
              <thead className="border-b border-border bg-muted">
                <tr>
                  <th scope="col" className={thClass}>{t("list.url")}</th>
                  <th scope="col" className={thClass}>{t("list.client")}</th>
                  <th scope="col" className={thClass}>{t("list.status")}</th>
                  <th scope="col" className={thClass}>{t("list.lastDelivery")}</th>
                  <th scope="col" className={thClass}>
                    <span className="sr-only">{t("list.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {hooks.map((h) => (
                  <tr key={h.id} className={h.status === "active" ? "text-foreground" : "text-muted-foreground"}>
                    <td className={`${tdClass} break-all`}>
                      <span className="font-bold">{h.url}</span>
                      {h.description && <span className="block text-xs text-muted-foreground">{h.description}</span>}
                    </td>
                    <td className={tdClass}>{clientName(h.workspaceId)}</td>
                    <td className={tdClass}>
                      <Pill tone={h.status === "active" ? "good" : "neutral"}>
                        {h.status === "active" ? t("list.active") : t("list.disabled")}
                      </Pill>
                      {h.disabledReason && (
                        <span className="mt-1 block text-xs text-muted-foreground">{t(`reason.${h.disabledReason}`)}</span>
                      )}
                    </td>
                    <td className={tdClass}>{lastDelivery(h.lastDelivery)}</td>
                    <td className={tdClass}>
                      <WebhookRowActions id={h.id} active={h.status === "active"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <p className="text-xs text-muted-foreground">{t("list.retentionNote")}</p>
        </div>
      )}
    </SettingsShell>
  );
}
