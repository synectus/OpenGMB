import "server-only";
import Link from "next/link";
import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { BACKUP_CODE_COUNT, type workspacesList } from "@opengmb/core";
import { workspaces_list } from "../app/_generated/actions";
import { actorContextFor, backupCodesLeft, getAuth, userHasPassword } from "../lib/auth";
import { isClientRole, organizationLine } from "../lib/account";
import { currentDensity } from "../lib/density";
import { THEME_COOKIE, parseTheme } from "../lib/preferences";
import { DisplayForm, PasswordForm, ProfileForm, TwoFactorPanel } from "./account-forms";
import { Pill } from "./page-parts";
import { PageHeader, Panel, linkClass, secondaryButtonClass } from "./ui";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

function Fact({ label, value, notLive, hint }: { label: string; value: ReactNode; notLive?: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border py-2 text-sm first:border-t-0">
      <span className="w-36 font-medium">{label}</span>
      <span>{value}</span>
      {notLive ? <Pill>{notLive}</Pill> : null}
      {hint ? <span className="text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/** The Account page body (D18), shared by /account (staff) and /portal/account (clients). */
export async function AccountSections({ userId, email }: { userId: string; email: string }) {
  const [session, ctx, hasPassword, left, jar, density] = await Promise.all([
    getAuth().api.getSession({ headers: await headers() }),
    actorContextFor(userId),
    userHasPassword(userId),
    backupCodesLeft(userId),
    cookies(),
    currentDensity(),
  ]);
  const t = await getTranslations("account");
  const tc = await getTranslations("common");
  const client = isClientRole(ctx.role);
  let workspaceNames: string[] = [];
  if (client) {
    const ws = await workspaces_list();
    workspaceNames = ws.ok
      ? (ws.data as Handler<typeof workspacesList>).workspaces.map((w) => w.name)
      : [];
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={client ? t("descriptionClient") : t("descriptionStaff")}
      />

      <Panel title={t("profile")}>
        <ProfileForm name={session?.user.name ?? ""} email={email} />
      </Panel>

      <Panel title={t("password")}>
        {hasPassword ? (
          <PasswordForm />
        ) : (
          <p className="text-sm">{t("googleSignIn")}</p>
        )}
      </Panel>

      <Panel title={t("twoFactor")}>
        <TwoFactorPanel hasPassword={hasPassword} left={left} total={BACKUP_CODE_COUNT} />
      </Panel>

      <Panel title={t("display")}>
        <DisplayForm theme={parseTheme(jar.get(THEME_COOKIE)?.value)} density={density} />
        <div className="flex flex-col">
          <Fact label={t("times")} value={t("timesValue")} />
          <Fact label={t("dates")} value={t("datesValue")} />
          <Fact
            label={t("distanceUnits")}
            value={
              <select aria-label={t("distanceUnits")} disabled className="rounded-md border border-input bg-card px-2 py-1">
                <option>{t("kilometres")}</option>
                <option>{t("miles")}</option>
              </select>
            }
            notLive={tc("notLive")}
            hint={t("distanceHint")}
          />
        </div>
      </Panel>

      <section className="flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-base font-bold">{t("sessions")}</h2>
          <Pill>{tc("notLive")}</Pill>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-1.5 font-medium">{t("device")}</th>
                <th scope="col" className="py-1.5 font-medium">{t("lastActive")}</th>
                <th scope="col" className="py-1.5 font-medium">{t("location")}</th>
                <th scope="col" className="py-1.5 font-medium">{t("action")}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border">
                <td colSpan={4} className="py-3 text-muted-foreground">
                  {t("sessionsNotLive")}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button type="button" className={secondaryButtonClass} disabled>
            {t("signOutOthers")}
          </button>
          <span className="text-muted-foreground">{t("eachConfirm")}</span>
        </div>
      </section>

      <Panel title={t("organization")}>
        <p className="text-sm font-medium">
          {organizationLine({ role: ctx.role, orgName: ctx.organization.name, workspaceNames })}
        </p>
        {client ? (
          <p className="text-sm text-muted-foreground">{t("organizationClient")}</p>
        ) : (
          <div className="flex gap-4">
            <Link href="/settings/google" className={linkClass}>
              {t("settings")}
            </Link>
            <Link href="/settings/tokens" className={linkClass}>
              {t("apiTokens")}
            </Link>
          </div>
        )}
      </Panel>
    </div>
  );
}
