import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { googleConnectionsList, locationsList } from "@opengmb/core";
import { GOOGLE_OAUTH_BRAND, MOCK_GOOGLE_EMAIL, roleHasPermission } from "@opengmb/core";
import { ConnectGoogleButton } from "../../../../components/connect-google-button";
import { ConnectSampleGoogleButton } from "../../../../components/connect-sample-google-button";
import { DisconnectGoogleButton } from "../../../../components/disconnect-google-button";
import { TableWrap, tdClass, thClass } from "../../../../components/page-parts";
import { SettingsShell } from "../../../../components/settings/settings-shell";
import { ErrorText, Panel, linkClass } from "../../../../components/ui";
import { actorContextFor } from "../../../../lib/auth";
import { connectionSummary, googleCallbackError, scopeLabels } from "../../../../lib/google-connection";
import { requireUser } from "../../../../lib/guard";
import { currentIsMainHost } from "../../../../lib/host-branding";
import { getTimeFormat } from "../../../../lib/time-format-server";
import { googleConnections_list, locations_list } from "../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

const warnBox = "rounded-panel border border-warn-border bg-warn-bg px-4 py-3 text-sm text-warn";

export default async function GoogleSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string; revoked?: string }>;
}) {
  const t = await getTranslations("settingsStatus");
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  const { connected, error, revoked } = await searchParams;
  const canManage = roleHasPermission(role, "google:manage");
  const [result, locs] = await Promise.all([googleConnections_list(), locations_list({})]);
  const data = result.ok ? (result.data as Handler<typeof googleConnectionsList>) : null;
  const locations = locs.ok ? (locs.data as Handler<typeof locationsList>).locations : [];
  const tf = await getTimeFormat();
  const failure = error ? googleCallbackError(error) : null;
  const mainHost = await currentIsMainHost();
  const mainOrigin = process.env.BETTER_AUTH_URL;

  return (
    <SettingsShell
      current="/settings/google"
      role={role}
      title={t("google.title")}
      description={t("google.description")}
    >
      {connected && (
        <p
          role="status"
          className="rounded-panel border border-good-border bg-good-bg px-4 py-3 text-sm font-semibold text-good"
        >
          {t("google.connected")}
        </p>
      )}
      {failure && (
        <p role="alert" className="rounded-panel border border-bad-border bg-bad-bg px-4 py-3 text-sm text-bad">
          <code className="font-mono font-semibold">{failure.code}</code>: {failure.text}
        </p>
      )}
      {revoked === "0" && (
        <p className={warnBox}>
          {t.rich("google.revokeWarning", {
            googleAppName: GOOGLE_OAUTH_BRAND.appName.value,
            link: (chunks) => (
              <a
                href="https://myaccount.google.com/permissions"
                className="font-semibold underline underline-offset-2"
                rel="noreferrer"
                target="_blank"
              >
                {chunks}
              </a>
            ),
          })}
        </p>
      )}
      {!data ? (
        <ErrorText message={result.ok ? null : `${result.error.code}: ${result.error.message}`} />
      ) : (
        <>
          <section aria-label={t("google.accountsLabel")} className="flex flex-col gap-3">
            {data.connections.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("google.none")}</p>
            ) : (
              <TableWrap>
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">{t("google.accountsLabel")}</caption>
                  <thead className="border-b border-border bg-muted">
                    <tr>
                      <th scope="col" className={thClass}>{t("google.colAccount")}</th>
                      <th scope="col" className={thClass}>{t("google.colConnectedBy")}</th>
                      <th scope="col" className={thClass}>{t("google.colConnected")}</th>
                      <th scope="col" className={thClass}>{t("google.colUpdated")}</th>
                      <th scope="col" className={thClass}>{t("google.colScopes")}</th>
                      {canManage && <th scope="col" className={thClass}>{t("google.colActions")}</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.connections.map((c) => (
                      <tr key={c.id}>
                        <td className={`${tdClass} font-semibold`}>{c.email}</td>
                        <td className={tdClass}>{c.connectedBy}</td>
                        <td className={`${tdClass} whitespace-nowrap`}>{tf.dateTime(c.createdAt)}</td>
                        <td className={`${tdClass} whitespace-nowrap`}>{tf.dateTime(c.updatedAt)}</td>
                        <td className={tdClass}>{scopeLabels(c.scopes)}</td>
                        {canManage && (
                          <td className={tdClass}>
                            <DisconnectGoogleButton id={c.id} />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
            {canManage && data.connections.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("google.disconnectNote")}
              </p>
            )}
            {!canManage && (
              <p className="text-sm text-muted-foreground">
                {t("google.onlyAdmins")}
              </p>
            )}
          </section>

          {!data.configured ? (
            <p className={warnBox}>
              {t("google.notConfigured")}
            </p>
          ) : mainHost || !mainOrigin ? (
            canManage && <ConnectGoogleButton />
          ) : (
            // Google's redirect address is registered for the main host only (D3).
            canManage && (
              <p className="text-sm text-muted-foreground">
                {t.rich("google.mainHostOnly", {
                  host: new URL(mainOrigin).host,
                  link: (chunks) => (
                    <a href={new URL("/settings/google", mainOrigin).toString()} className={linkClass}>
                      {chunks}
                    </a>
                  ),
                })}
              </p>
            )
          )}

          {canManage && data.sampleAvailable && !data.connections.some((c) => c.email === MOCK_GOOGLE_EMAIL) && (
            <ConnectSampleGoogleButton />
          )}

          {data.connections.length > 0 && (
            <>
              <Panel title={t("google.seeTitle")}>
                <p className="text-sm">{connectionSummary(data.connections.length, locations)}</p>
                {roleHasPermission(role, "location:manage") && (
                  <Link href="/locations/import" className={linkClass}>
                    {t("google.importLocations")}
                  </Link>
                )}
              </Panel>
              <Panel title={t("google.reconnectTitle")}>
                <p className="text-sm text-muted-foreground">
                  {t("google.reconnectBody")}
                </p>
              </Panel>
            </>
          )}
        </>
      )}
    </SettingsShell>
  );
}
