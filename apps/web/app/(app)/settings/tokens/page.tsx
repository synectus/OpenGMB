import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { apiTokensList } from "@opengmb/core";
import { CreateTokenForm } from "../../../../components/create-token-form";
import { Pill, TableWrap, primaryLinkButtonClass, tdClass, thClass } from "../../../../components/page-parts";
import { RevokeTokenButton } from "../../../../components/revoke-token-button";
import { SettingsShell } from "../../../../components/settings/settings-shell";
import { EmptyState, ErrorText, Panel } from "../../../../components/ui";
import { actorContextFor } from "../../../../lib/auth";
import { requireUser } from "../../../../lib/guard";
import { getTimeFormat } from "../../../../lib/time-format-server";
import { mcpUrlFrom } from "../../../../lib/mcp-connect";
import { tokenCreated } from "../../../../lib/tokens-view";
import { apiTokens_list } from "../../../_generated/actions";

type Listed = Awaited<ReturnType<typeof apiTokensList.handler>>;

export default async function TokensPage() {
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  const t = await getTranslations("settingsTeam.tokens");
  const result = await apiTokens_list();
  const tokens = result.ok ? (result.data as Listed).tokens : [];
  const tf = await getTimeFormat();
  const showOwner = tokens.some((x) => x.ownerUserId !== userId);

  return (
    <SettingsShell
      current="/settings/tokens"
      role={role}
      title={t("title")}
      description={t("description")}
    >
      <Panel title={t("createToken")}>
        <CreateTokenForm readOnlyOnly={role === "client_viewer"} mcpUrl={mcpUrlFrom(process.env)} />
      </Panel>

      {!result.ok ? (
        <ErrorText message={`${result.error.code}: ${result.error.message}`} />
      ) : tokens.length === 0 ? (
        <EmptyState title={t("emptyTitle")}>
          {t("emptyBody")}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          <TableWrap>
            <table className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">{t("caption")}</caption>
              <thead className="border-b border-border bg-muted">
                <tr>
                  <th scope="col" className={thClass}>{t("name")}</th>
                  {showOwner && <th scope="col" className={thClass}>{t("owner")}</th>}
                  <th scope="col" className={thClass}>{t("access")}</th>
                  <th scope="col" className={thClass}>{t("mode")}</th>
                  <th scope="col" className={thClass}>{t("created")}</th>
                  <th scope="col" className={thClass}>{t("lastUsed")}</th>
                  <th scope="col" className={thClass}>{t("status")}</th>
                  <th scope="col" className={thClass}>
                    <span className="sr-only">{t("actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tokens.map((x) => (
                  <tr key={x.id} className={x.revokedAt ? "text-muted-foreground" : "text-foreground"}>
                    <td className={`${tdClass} font-bold`}>{x.name}</td>
                    {showOwner && <td className={`${tdClass} break-all`}>{x.ownerEmail}</td>}
                    <td className={tdClass}>{x.scopes.includes("write") ? t("readWrite") : t("readOnly")}</td>
                    <td className={tdClass}>
                      {x.mode === "full_autonomy" ? t("modeFullAutonomy") : t("modeHumanInTheLoop")}
                    </td>
                    <td className={`${tdClass} tabular-nums`}>{tokenCreated(x.createdAt, tf)}</td>
                    <td className={`${tdClass} tabular-nums`}>{x.lastUsedAt ? tf.dateTime(x.lastUsedAt) : t("never")}</td>
                    <td className={tdClass}>
                      <Pill tone={x.revokedAt ? "neutral" : "good"}>{x.revokedAt ? t("revokedOn", { date: tf.date(x.revokedAt) }) : t("active")}</Pill>
                    </td>
                    <td className={tdClass}>{!x.revokedAt && <RevokeTokenButton id={x.id} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <p className="text-xs text-muted-foreground">
            {t("revokeNote")}
          </p>
        </div>
      )}

      <section
        aria-label={t("connectLabel")}
        className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-agent-border bg-agent-bg p-4"
      >
        <span className="text-sm text-foreground">
          {t("connectText")}
        </span>
        <Link href="/agents" className={primaryLinkButtonClass}>
          {t("connectLink")}
        </Link>
      </section>
    </SettingsShell>
  );
}
