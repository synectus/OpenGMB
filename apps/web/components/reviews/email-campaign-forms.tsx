"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { reviewRequests_addRecipients, reviewRequests_cancel, reviewRequests_create, reviewRequests_importCsv, reviewRequests_start } from "../../app/_generated/actions";
import { buttonClass, ErrorText, inputClass, secondaryButtonClass } from "../ui";

// Keys of core's LIST_SOURCES (client components do not import core at runtime).
const SOURCES = ["purchase", "booking", "visit"] as const;

type Result = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
const errText = (r: Result) => (r.ok ? null : `${r.error.code}: ${r.error.message}`);

export function NewCampaignForm({ locationId }: { locationId: string }) {
  const router = useRouter();
  const t = useTranslations("reviewsTools");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [reminder, setReminder] = useState(true);
  const [days, setDays] = useState(3);
  const [error, setError] = useState<string | null>(null);
  if (!open) return <div><button type="button" className={secondaryButtonClass} onClick={() => setOpen(true)}>{t("emailCampaigns.newCampaign")}</button></div>;
  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-border bg-muted p-3.5"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = (await reviewRequests_create({ locationId, name, ...(subject ? { subject } : {}), ...(body ? { body } : {}), reminderEnabled: reminder, reminderDays: days })) as Result;
        setError(errText(r));
        if (r.ok) {
          setOpen(false);
          router.refresh();
        }
      }}
    >
      <label className="flex flex-col gap-1.5 text-[13px] font-semibold">{t("emailCampaigns.name")}
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} required maxLength={120} />
      </label>
      <label className="flex flex-col gap-1.5 text-[13px] font-semibold">{t("emailCampaigns.subject")}
        <input value={subject} onChange={(e) => setSubject(e.target.value)} className={inputClass} maxLength={150} placeholder={t("emailCampaigns.defaultHint")} />
      </label>
      <label className="flex flex-col gap-1.5 text-[13px] font-semibold">{t("emailCampaigns.body")}
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={1500} className="rounded-md border border-input bg-card p-2.5 text-sm" placeholder={t("emailCampaigns.defaultHint")} />
      </label>
      <p className="text-xs text-muted-foreground">{t("emailCampaigns.variables")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[13px] font-semibold">
          <input type="checkbox" checked={reminder} onChange={(e) => setReminder(e.target.checked)} />
          {t("emailCampaigns.remind")}
        </label>
        {reminder && (
          <label className="flex items-center gap-2 text-[13px] font-semibold">{t("emailCampaigns.afterDays")}
            <input type="number" min={1} max={14} value={days} onChange={(e) => setDays(Number(e.target.value))} className={`${inputClass} w-20`} />
          </label>
        )}
      </div>
      <div className="flex gap-2">
        <button type="submit" className={buttonClass}>{t("emailCampaigns.create")}</button>
        <button type="button" className={secondaryButtonClass} onClick={() => setOpen(false)}>{t("emailCampaigns.close")}</button>
      </div>
      <ErrorText message={error} />
    </form>
  );
}

type Added = { added: number; duplicates: number; invalid: number; alreadyOptedOut: number };

export function CampaignActions({ campaignId, status }: { campaignId: string; status: "draft" | "active" | "cancelled" }) {
  const router = useRouter();
  const t = useTranslations("reviewsTools");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [csv, setCsv] = useState("");
  const [permission, setPermission] = useState(false);
  const [source, setSource] = useState<(typeof SOURCES)[number] | "">("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const report = (r: Result) => {
    setError(errText(r));
    if (r.ok) {
      const a = r.data as Added;
      setNote(t("emailCampaigns.addedSummary", a));
      router.refresh();
    }
  };
  return (
    <div className="flex flex-col gap-2.5 border-t border-border pt-2.5">
      <label className="flex max-w-md flex-col gap-1 text-xs font-semibold">{t("emailCampaigns.listSource")}
        <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} className={inputClass}>
          <option value="">{t("emailCampaigns.listSourcePick")}</option>
          {SOURCES.map((k) => <option key={k} value={k}>{t(`emailCampaigns.source_${k}`)}</option>)}
        </select>
      </label>
      <ul className="list-disc pl-5 text-xs text-muted-foreground">
        {(["rule1", "rule2", "rule3", "rule4"] as const).map((k) => <li key={k}>{t(`emailCampaigns.${k}`)}</li>)}
      </ul>
      <label className="flex items-start gap-2 text-xs font-semibold">
        <input type="checkbox" checked={permission} onChange={(e) => setPermission(e.target.checked)} className="mt-0.5" />
        {t("emailCampaigns.permission")}
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs font-semibold">{t("emailCampaigns.email")}
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold">{t("emailCampaigns.customerName")}
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </label>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={!permission || !source || !email}
          onClick={async () => {
            const r = (await reviewRequests_addRecipients({ campaignId, recipients: [{ email, name: name || null }], listSource: source as (typeof SOURCES)[number], confirmPermission: true })) as Result;
            report(r);
            if (r.ok) { setEmail(""); setName(""); }
          }}
        >
          {t("emailCampaigns.addOne")}
        </button>
      </div>
      <label className="flex flex-col gap-1 text-xs font-semibold">{t("emailCampaigns.csv")}
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={3} className="rounded-md border border-input bg-card p-2 font-mono text-xs" placeholder="email,name" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input type="file" accept=".csv,text/csv" aria-label={t("emailCampaigns.csvFile")} onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} className="text-xs" />
        <button type="button" className={secondaryButtonClass} disabled={!permission || !source || !csv.trim()} onClick={async () => { const r = (await reviewRequests_importCsv({ campaignId, csv, listSource: source as (typeof SOURCES)[number], confirmPermission: true })) as Result; report(r); if (r.ok) setCsv(""); }}>
          {t("emailCampaigns.importCsv")}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {status === "draft" && (
          <button type="button" className={buttonClass} onClick={async () => { const r = (await reviewRequests_start({ campaignId })) as Result; setError(errText(r)); if (r.ok) router.refresh(); }}>
            {t("emailCampaigns.start")}
          </button>
        )}
        <button type="button" className={secondaryButtonClass} onClick={async () => { const r = (await reviewRequests_cancel({ campaignId })) as Result; setError(errText(r)); if (r.ok) router.refresh(); }}>
          {t("emailCampaigns.cancel")}
        </button>
      </div>
      {note && <p role="status" className="text-xs text-good">{note}</p>}
      <ErrorText message={error} />
    </div>
  );
}
