import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { notificationsList } from "@opengmb/core";
import { emailConfigured, pushConfig } from "@opengmb/core";
import { PushDevice } from "../../../../components/notifications/push-device";
import { MarkAllRead, NotificationList } from "../../../../components/notifications/notification-list";
import { PillLinks, Pill, TableWrap, tdClass, thClass } from "../../../../components/page-parts";
import { SettingsShell } from "../../../../components/settings/settings-shell";
import { buttonClass, ErrorText, inputClass, linkClass } from "../../../../components/ui";
import { actorContextFor } from "../../../../lib/auth";
import { requireUser } from "../../../../lib/guard";
import { listFooter, notificationsHref, PAGE, parseShow, PREFERENCE_ROWS } from "../../../../lib/notification-list";
import { notifications_list } from "../../../_generated/actions";

type Listed = Awaited<ReturnType<typeof notificationsList.handler>>;

const panel = "flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card";

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; show?: string }>;
}) {
  const t = await getTranslations("settingsStatus.notifications");
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  const { filter, show } = await searchParams;
  const unread = filter === "unread";
  const limit = parseShow(show);
  const result = await notifications_list({ unreadOnly: unread, limit });
  const data = result.ok ? (result.data as Listed) : null;
  const footer = data ? listFooter(data.items.length, limit, unread) : null;
  const pushKey = pushConfig()?.publicKey ?? null;

  return (
    <SettingsShell
      current="/settings/notifications"
      role={role}
      title={t("title")}
      description={t("description")}
    >
      <section aria-labelledby="all-h" className={panel}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 id="all-h" className="font-display text-lg font-bold">{t("allTitle")}</h2>
          <MarkAllRead disabled={!data || data.unreadCount === 0} />
        </div>
        <PillLinks
          label={t("filterLabel")}
          items={[
            { href: notificationsHref({ unread: false, show: PAGE }), label: t("all"), current: !unread },
            { href: notificationsHref({ unread: true, show: PAGE }), label: t("unread", { count: String(data?.unreadCount ?? 0) }), current: unread },
          ]}
        />
        {!data ? (
          <ErrorText message={result.ok ? null : `${result.error.code}: ${result.error.message}`} />
        ) : data.items.length === 0 ? (
          unread ? (
            <p role="status" className="text-sm">{t("caughtUp")}</p>
          ) : (
            <div className="flex flex-col gap-1 py-4 text-center">
              <p className="font-semibold">{t("none")}</p>
              <p className="text-sm text-muted-foreground">{t("noneBody")}</p>
            </div>
          )
        ) : (
          <NotificationList items={data.items} />
        )}
        {footer && footer.caption && (
          <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
            {footer.olderHref && (
              <Link href={footer.olderHref} className={linkClass}>
                {t("older")}
              </Link>
            )}
            <span>{footer.caption}</span>
          </div>
        )}
      </section>

      {pushKey && (
        <section aria-labelledby="push-h" className={panel}>
          <h2 id="push-h" className="font-display text-lg font-bold">{t("pushTitle")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("pushBody")}
          </p>
          <PushDevice publicKey={pushKey} />
        </section>
      )}

      <form aria-label={t("emailTitle")} className={panel}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-lg font-bold">{t("emailTitle")}</h2>
          <Pill tone="warn">{t("notLive")}</Pill>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("emailBody")}
        </p>
        {!emailConfigured() && (
          <p className="text-sm text-muted-foreground">
            {t("emailNotSent")}
          </p>
        )}
        <fieldset disabled className="flex flex-col gap-4">
          <TableWrap>
            <table className="w-full text-left text-sm">
              <caption className="sr-only">{t("tableCaption")}</caption>
              <thead className="border-b border-border bg-muted">
                <tr>
                  {[t("colNotification"), t("colInApp"), t("colEmail"), t("colDigest")].map((h) => (
                    <th key={h} scope="col" className={thClass}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {PREFERENCE_ROWS.map((r) => (
                  <tr key={r.kind}>
                    <td className={tdClass}>{r.label}</td>
                    {(
                      [
                        [t("colInAppLower"), r.inApp],
                        [t("colEmailLower"), r.email],
                        [t("colDigestLower"), r.digest],
                      ] as const
                    ).map(([col, on]) => (
                      <td key={col} className={tdClass}>
                        <input type="checkbox" aria-label={t("rowAria", { label: r.label, column: col })} checked={on} readOnly className="size-4 accent-primary" />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-bold">{t("digestTitle")}</h3>
            <label className="flex max-w-xs flex-col gap-1 text-sm font-semibold">
              {t("sendDigest")}
              <select defaultValue="daily" className={`${inputClass} font-normal`}>
                <option value="daily">{t("optDaily")}</option>
                <option value="weekdays">{t("optWeekdays")}</option>
                <option value="off">{t("optOff")}</option>
              </select>
            </label>
            <label className="flex items-center gap-2.5 text-sm">
              <input type="checkbox" checked readOnly className="size-4 accent-primary" />
              {t("skipDigest")}
            </label>
          </div>
          <div>
            <button type="button" className={buttonClass}>{t("save")}</button>
          </div>
        </fieldset>
      </form>
    </SettingsShell>
  );
}
