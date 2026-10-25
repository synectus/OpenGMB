"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { branding_update } from "../app/_generated/actions";
import { brandingInputError, contrastReadout, previewBrand, previewStyle } from "../lib/branding-form";
import { Pill, TableWrap, tdClass, thClass } from "./page-parts";
import { LogoUploader } from "./logo-uploader";
import { buttonClass, ErrorText, inputClass, secondaryButtonClass } from "./ui";

type Values = { agencyName: string; logoUrl: string | null; primaryColor: string | null; accentColor: string | null };

const section = "flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card";

function Heading({ children, notLive }: { children: ReactNode; notLive?: boolean }) {
  const t = useTranslations("settings.brandingForm");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="font-display text-lg font-bold">{children}</h2>
      {notLive && <Pill tone="warn">{t("notLive")}</Pill>}
    </div>
  );
}

function DnsTable({ caption, head, rows }: { caption: string; head: string; rows: [string, string][] }) {
  const t = useTranslations("settings.brandingForm");
  return (
    <TableWrap>
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-border bg-muted">
          <tr>
            {[head, t("dnsName"), t("dnsValue"), t("dnsStatus")].map((h) => (
              <th key={h} scope="col" className={thClass}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(([type, name]) => (
            <tr key={`${type}-${name}`}>
              <td className={tdClass}>{type}</td>
              <td className={`${tdClass} font-mono text-xs`}>{name}</td>
              <td className={`${tdClass} text-muted-foreground`}>{t("dnsShownLater")}</td>
              <td className={tdClass}><Pill>{t("dnsNotChecked")}</Pill></td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

export type LogoData = {
  orgFileId: string | null;
  clients: { id: string; name: string; fileId: string | null }[];
  /** Owners and admins only: bytes used and the allowance. */
  usage: { usedBytes: number; limitBytes: number } | null;
};

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function BrandingForm({
  initial,
  canEdit,
  emailOn,
  logos,
  domain = null,
}: {
  initial: Values;
  canEdit: boolean;
  emailOn: boolean;
  logos: LogoData;
  /** The organization's own address, read-only here: a platform admin sets it (Settings, Organizations). */
  domain?: { host: string | null; senderEmail: string | null; senderVerified: boolean; dnsTarget: string | null } | null;
}) {
  const t = useTranslations("settings.brandingForm");
  const router = useRouter();
  const [v, setV] = useState({
    agencyName: initial.agencyName,
    logoUrl: initial.logoUrl ?? "",
    primaryColor: initial.primaryColor ?? "",
    accentColor: initial.accentColor ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => {
    setSaved(false);
    setV((x) => ({ ...x, [k]: e.target.value }));
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const bad = brandingInputError(v);
    if (bad) return setError(bad);
    setPending(true);
    setError(null);
    // An empty box clears the field (null).
    const result = await branding_update({
      agencyName: v.agencyName.trim() || null,
      logoUrl: v.logoUrl.trim() || null,
      primaryColor: v.primaryColor.trim() || null,
      accentColor: v.accentColor.trim() || null,
    });
    setPending(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    setSaved(true);
    router.refresh();
  }

  const readout = contrastReadout(v.primaryColor);
  const brand = previewBrand(v);
  const field = (id: keyof typeof v, label: string, extra: Record<string, unknown> = {}) => (
    <label className="flex flex-col gap-1 text-sm font-semibold">
      {label}
      <input id={id} value={v[id]} onChange={set(id)} disabled={!canEdit} className={`${inputClass} font-normal`} {...extra} />
    </label>
  );

  return (
    <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
      <form onSubmit={onSubmit} aria-label={t("formLabel")} className="flex min-w-0 flex-1 flex-col gap-4">
        <section aria-label={t("agencyName")} className={section}>
          <Heading>{t("agencyName")}</Heading>
          {field("agencyName", t("agencyName"), { maxLength: 100 })}
        </section>

        <section aria-label={t("logo")} className={section}>
          <Heading>{t("logo")}</Heading>
          <p className="text-[13px] text-muted-foreground">{t("dropHere")}</p>
          <LogoUploader label={t("agencyLogo")} fileId={logos.orgFileId} canEdit={canEdit} />
          {logos.clients.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-bold">{t("clientLogos")}</h3>
              {logos.clients.map((c) => (
                <LogoUploader key={c.id} label={t("clientLogoFor", { name: c.name })} workspaceId={c.id} fileId={c.fileId} canEdit={canEdit} />
              ))}
            </div>
          )}
          {logos.usage && (
            <p className="text-[13px] text-muted-foreground">
              <span role="status" className="font-semibold text-foreground">
                {t("storageUsed", { used: mb(logos.usage.usedBytes), limit: mb(logos.usage.limitBytes) })}
              </span>{" "}
              {t("storageNote")}
            </p>
          )}
          {field("logoUrl", t("logoUrl"), { type: "url", placeholder: "https://example.com/logo.png" })}
          <p className="text-[13px] text-muted-foreground">{t("logoUsedIn")}</p>
        </section>

        <section aria-label={t("colours")} className={section}>
          <Heading>{t("colours")}</Heading>
          <div className="grid gap-3 sm:grid-cols-2">
            {field("primaryColor", t("primaryColour"), { placeholder: "#1d4ed8" })}
            {field("accentColor", t("accentColour"), { placeholder: "#0f766e" })}
          </div>
          {readout && (
            <p
              role="status"
              className={`rounded-control border px-3 py-2 text-sm font-semibold ${
                readout.tone === "good" ? "border-good-border bg-good-bg text-good" : "border-warn-border bg-warn-bg text-warn"
              }`}
            >
              {readout.text}
            </p>
          )}
          <p className="text-[13px] text-muted-foreground">
            {t("contrastNote")}
          </p>
        </section>

        {domain?.host ? (
          <section aria-label={t("customDomain")} className={section}>
            <Heading>{t("customDomain")}</Heading>
            <p className="text-sm">{t("addressIs", { host: domain.host })}</p>
            {domain.dnsTarget && (
              <p className="text-[13px] text-muted-foreground">{t("cnameInstruction", { host: domain.host, target: domain.dnsTarget })}</p>
            )}
            {domain.senderEmail && (
              <p className="text-sm">
                {domain.senderVerified
                  ? t("senderOn", { sender: domain.senderEmail })
                  : t("senderWaiting", { sender: domain.senderEmail })}
              </p>
            )}
          </section>
        ) : (
        <section aria-label={t("customDomain")} className={section}>
          <Heading notLive>{t("customDomain")}</Heading>
          <label className="flex flex-col gap-1 text-sm font-semibold">
            {t("appDomain")}
            <input disabled placeholder="app.youragency.com" className={`${inputClass} font-normal`} />
          </label>
          <DnsTable caption={t("dnsCaptionDomain")} head={t("dnsTypeHead")} rows={[["CNAME", "app"], ["TXT", "_opengmb"]]} />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled className={secondaryButtonClass}>{t("checkDns")}</button>
            <span className="text-[13px] text-muted-foreground">
              {t("dnsDelay")}
            </span>
          </div>
        </section>
        )}

        {domain?.host ? null : (
        <section aria-label={t("emailDomain")} className={section}>
          <Heading notLive>{t("emailDomain")}</Heading>
          <label className="flex flex-col gap-1 text-sm font-semibold">
            {t("sendFrom")}
            <input type="email" disabled placeholder="reports@youragency.com" className={`${inputClass} font-normal`} />
          </label>
          <DnsTable
            caption={t("dnsCaptionEmail")}
            head={t("dnsRecordHead")}
            rows={[["SPF (TXT)", "@"], ["DKIM (CNAME)", "selector._domainkey"], ["Return-Path (CNAME)", "bounce"]]}
          />
          {!emailOn && (
            <p className="text-[13px] text-muted-foreground">{t("needsProvider")}</p>
          )}
        </section>
        )}

        <ErrorText message={error} />
        {saved && <p role="status" className="text-sm font-semibold text-good">{t("saved")}</p>}
        {canEdit ? (
          <div>
            <button type="submit" className={buttonClass} disabled={pending}>{t("save")}</button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("ownersOnly")}</p>
        )}
      </form>

      <aside
        aria-label={t("preview")}
        style={previewStyle(v.primaryColor, v.accentColor) as CSSProperties}
        className="flex flex-col gap-4 rounded-panel border border-border bg-background p-(--panel-p) text-foreground shadow-card xl:sticky xl:top-[calc(var(--shell-top)+1rem)] xl:w-[340px]"
      >
        <h2 className="font-display text-lg font-bold">{t("preview")}</h2>
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{t("appHeader")}</span>
          <div className="flex items-center gap-2.5 rounded-control border border-border bg-card p-3">
            {brand.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- agency-supplied https URL, as in the shell
              <img src={brand.logoUrl} alt="" className="h-8 w-auto" />
            ) : (
              <span aria-hidden className="flex size-8 items-center justify-center rounded-[9px] bg-brand font-display text-[17px] font-extrabold text-brand-foreground">
                {brand.mark}
              </span>
            )}
            <span className="font-display font-extrabold">{brand.name}</span>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{t("buttonAndChip")}</span>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex min-h-9 items-center rounded-control bg-primary px-4 text-sm font-semibold text-primary-foreground">
              {t("previewSave")}
            </span>
            <span className="inline-flex h-7 items-center rounded-full bg-brand-tint px-3 text-[13px] font-semibold text-brand-text">
              {t("accentChip")}
            </span>
          </div>
        </div>
        {!brand.branded && (
          <p className="text-[13px] text-muted-foreground">{t("noBranding")}</p>
        )}
        <p className="text-xs text-muted-foreground">{t("lightTheme")}</p>
      </aside>
    </div>
  );
}
