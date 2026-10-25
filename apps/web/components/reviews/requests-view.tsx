import { getTranslations } from "next-intl/server";
import type { reviewLinksGet, reviewsList, workspacesList } from "@opengmb/core";
import { reviewLinks_get, reviews_list, workspaces_list } from "../../app/_generated/actions";
import { trackedUrl } from "../../lib/review-requests";
import { filterFieldClass } from "../page-parts";
import { EmptyState, ErrorText, Panel, secondaryButtonClass } from "../ui";
import { CopyButton } from "../agents/copy-button";
import { EmailCampaigns } from "./email-campaigns";
import { CreateLinkForm, MessageComposer, WidgetSettings } from "./requests-forms";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Got = Handler<typeof reviewLinksGet>;
const linkButton = secondaryButtonClass;

export async function RequestsView({
  sp,
  locations,
  origin,
  canManage,
}: {
  sp: { ws?: string; loc?: string };
  locations: { id: string; name: string; workspaceId: string }[];
  origin: string;
  canManage: boolean;
}) {
  const t = await getTranslations("reviewsTools");
  const options = locations.filter((l) => !sp.ws || l.workspaceId === sp.ws);
  const chosen = options.find((l) => l.id === sp.loc) ?? options[0];
  if (!chosen) return <EmptyState title={t("requests.noLocTitle")}>{t("requests.noLocBody")}</EmptyState>;
  const res = await reviewLinks_get({ locationId: chosen.id });
  const d = res.ok ? (res.data as Got) : null;
  const wsRes = await workspaces_list();
  const ws = wsRes.ok ? (wsRes.data as Handler<typeof workspacesList>).workspaces.find((w) => w.id === chosen.workspaceId) : undefined;
  // Same rule as core's sendingBlock; the server enforces it, this only explains it.
  const block = ws?.hipaaCoveredEntity ? "hipaa" : ws && !(ws.senderLegalName && ws.senderPostalAddress) ? "identity" : null;

  return (
    <div className="flex flex-col gap-4">
      <form method="get" aria-label={t("requests.locationLabel")} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="view" value="requests" />
        {sp.ws && <input type="hidden" name="ws" value={sp.ws} />}
        <label className="flex items-center gap-2 text-[13px] font-semibold">
          {t("requests.locationLabel")}
          <select name="loc" defaultValue={chosen.id} className={filterFieldClass}>
            {options.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <button type="submit" className={secondaryButtonClass}>{t("requests.show")}</button>
        {d && d.workspaceProfile !== "general" && (
          <span className="text-[13px] text-muted-foreground">{d.workspaceProfile === "healthcare" ? t("requests.healthcareClient") : t("requests.legalClient")}</span>
        )}
      </form>
      {!res.ok && <ErrorText message={`${res.error.code}: ${res.error.message}`} />}

      <div role="note" className="flex items-start gap-3 rounded-panel border border-warn-border bg-warn-bg p-3.5 text-warn">
        <span>
          <strong>{t("requests.noteStrong")}</strong> {t("requests.noteBody")}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{t("requests.readsOnly")}</p>

      {d && !d.link && (
        <Panel title={t("requests.createTitle")} description={t("requests.createDesc")}>
          <CreateLinkForm locationId={chosen.id} suggested={d.suggestedPlaceId} />
        </Panel>
      )}

      {d?.link && <LinkPanels d={d} locationId={chosen.id} origin={origin} />}
      {d?.link && <EmailCampaigns locationId={chosen.id} workspaceId={chosen.workspaceId} block={block} canManage={canManage} />}
    </div>
  );
}

async function LinkPanels({ d, locationId, origin }: { d: Got; locationId: string; origin: string }) {
  const t = await getTranslations("reviewsTools");
  const link = d.link!;
  const tracked = trackedUrl(origin, link.slug, "link");
  const c = d.clicks30d;
  const min = link.widget.minRating;
  const preview = await reviews_list({ locationIds: [locationId], ratings: [1, 2, 3, 4, 5].filter((n) => n >= min), limit: 2 });
  const cards = preview.ok ? (preview.data as Handler<typeof reviewsList>).items : [];
  const qr = `/api/review-links/${locationId}/qr`;
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(380px,1fr))] items-start gap-4">
      <Panel title={t("requests.linkPanel")}>
        <ReadOnly label={t("requests.trackedLabel")} value={tracked} copy={t("requests.copyTracked")} />
        <ReadOnly label={t("requests.googleLinkLabel")} value={link.googleReviewUrl} copy={t("requests.copyGoogle")} />
        <div className="grid grid-cols-4 gap-2 text-center">
          {[[t("requests.qrScans"), c.qr], [t("requests.text"), c.sms], [t("requests.email"), c.email], [t("requests.link"), c.link]].map(([label, n]) => (
            <div key={label} className="rounded-lg bg-muted px-1.5 py-2.5"><div className="font-display text-xl font-extrabold tabular-nums">{n}</div><div className="text-xs text-muted-foreground">{label}</div></div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("requests.opens30", { count: d.newReviews30d })}
        </p>
      </Panel>

      <Panel title={t("requests.qrTitle")}>
        <div className="flex items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- same-origin SVG from the authorised QR route */}
          <img src={qr} alt={t("requests.qrAlt", { name: d.location.name })} width={152} height={152} className="rounded-xl border border-border bg-card p-3" />
          <div className="flex flex-col gap-2">
            <span className="text-[13px]">{t("requests.qrPoints")}</span>
            <a href={`${qr}?format=png`} download className={linkButton}>{t("requests.downloadPng")}</a>
            <a href={`${qr}?format=pdf`} download className="inline-flex min-h-(--control-h) items-center justify-center rounded-control bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary-hover">{t("requests.counterCard")}</a>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("requests.counterNote")}</p>
      </Panel>

      <Panel title={t("requests.messagesTitle")}>
        <MessageComposer locationName={d.location.name} smsLink={trackedUrl(origin, link.slug, "sms")} emailLink={trackedUrl(origin, link.slug, "email")} />
      </Panel>

      <Panel title={t("requests.widgetTitle")}>
        <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-muted p-3.5">
          <div className="flex items-center gap-2">
            <strong className="font-display text-xl">{d.summary.avgRating ?? t("none")}</strong>
            <span className="text-xs text-muted-foreground">{t("requests.googleReviews", { count: d.summary.count })}</span>
          </div>
          {link.widget.layout !== "badge" && cards.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {cards.map((r) => (
                <div key={r.id} className="rounded-lg border border-border bg-card p-2.5 text-xs leading-[17px]">
                  <span className="text-brand">{"★".repeat(r.rating ?? 0)}</span>
                  <br />
                  {r.comment ? `"${r.comment.slice(0, 80)}"` : ""}
                </div>
              ))}
            </div>
          )}
          <span className="text-[11px] text-muted-foreground">{link.widget.note}</span>
        </div>
        <p className="text-xs text-muted-foreground">{t("requests.widgetPreview")}</p>
        <WidgetSettings locationId={locationId} enabled={link.widget.enabled} minRating={min} layout={link.widget.layout} origin={origin} slug={link.slug} />
        {!link.widget.enabled && <p className="text-xs text-warn">{t("requests.widgetOff")}</p>}
        <p className="text-xs text-muted-foreground">{t("requests.widgetLowest")}</p>
      </Panel>
    </div>
  );
}

function ReadOnly({ label, value, copy }: { label: string; value: string; copy: string }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
      {label}
      <span className="flex gap-2">
        <input readOnly value={value} className="min-h-(--control-h) min-w-0 flex-1 rounded-md border border-input bg-muted px-3 font-mono text-[13px] font-medium" />
        <CopyButton text={value} label={copy} />
      </span>
    </label>
  );
}
