import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { reviewRequestsList } from "@opengmb/core";
import { reviewRequests_list } from "../../app/_generated/actions";
import { Badge, ErrorText, linkClass, Panel } from "../ui";
import { CampaignActions, NewCampaignForm } from "./email-campaign-forms";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Campaign = Handler<typeof reviewRequestsList>["campaigns"][number];

export async function EmailCampaigns({ locationId, workspaceId, block, canManage }: { locationId: string; workspaceId: string; block: "hipaa" | "identity" | null; canManage: boolean }) {
  const t = await getTranslations("reviewsTools");
  const res = await reviewRequests_list({ locationId });
  const campaigns = res.ok ? (res.data as Handler<typeof reviewRequestsList>).campaigns : [];
  if (block === "hipaa") {
    return (
      <Panel title={t("emailCampaigns.title")} description={t("emailCampaigns.intro")}>
        <p role="note" className="text-[13px] font-semibold text-bad">{t("emailCampaigns.hipaaBlocked")}</p>
        <Link href={`/settings/workspace?ws=${workspaceId}`} className={linkClass}>{t("emailCampaigns.settingsLink")}</Link>
      </Panel>
    );
  }
  return (
    <Panel title={t("emailCampaigns.title")} description={t("emailCampaigns.intro")}>
      {!res.ok && <ErrorText message={`${res.error.code}: ${res.error.message}`} />}
      <p className="text-xs text-muted-foreground">{t("emailCampaigns.limits")}</p>
      {block === "identity" && (
        <p role="note" className="text-[13px] font-semibold text-warn">
          {t("emailCampaigns.needIdentity")}{" "}
          <Link href={`/settings/workspace?ws=${workspaceId}`} className={linkClass}>{t("emailCampaigns.identityLink")}</Link>
        </p>
      )}
      {canManage ? <NewCampaignForm locationId={locationId} /> : <p className="text-xs text-muted-foreground">{t("emailCampaigns.viewOnly")}</p>}
      {campaigns.length === 0 && <p className="text-[13px] text-muted-foreground">{t("emailCampaigns.none")}</p>}
      <div className="flex flex-col gap-3">
        {campaigns.map((c) => (
          <CampaignCard key={c.id} c={c} canManage={canManage} />
        ))}
      </div>
    </Panel>
  );
}

async function CampaignCard({ c, canManage }: { c: Campaign; canManage: boolean }) {
  const t = await getTranslations("reviewsTools");
  const r = c.results;
  const cells: [string, number][] = [
    [t("emailCampaigns.rRecipients"), r.recipients],
    [t("emailCampaigns.rSent"), r.sent],
    [t("emailCampaigns.rClicked"), r.clicked],
    [t("emailCampaigns.rReminder"), r.reminderSent],
    [t("emailCampaigns.rOptedOut"), r.optedOut],
    [t("emailCampaigns.rWaiting"), r.waiting],
    [t("emailCampaigns.rSkipped"), r.skipped],
    [t("emailCampaigns.rFailed"), r.failed],
  ];
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm">{c.name}</strong>
        <Badge tone={c.status === "active" ? "success" : "neutral"}>{t(`emailCampaigns.status_${c.status}`)}</Badge>
        <span className="text-xs text-muted-foreground">
          {c.reminderEnabled ? t("emailCampaigns.reminderIn", { days: c.reminderDays }) : t("emailCampaigns.noReminder")}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2 text-center">
        {cells.map(([label, n]) => (
          <div key={label} className="rounded-lg bg-muted px-1.5 py-2">
            <div className="font-display text-lg font-extrabold tabular-nums">{n}</div>
            <div className="text-[11px] text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">{t("emailCampaigns.noDelivery")}</p>
      {canManage && c.status !== "cancelled" && <CampaignActions campaignId={c.id} status={c.status} />}
    </div>
  );
}
