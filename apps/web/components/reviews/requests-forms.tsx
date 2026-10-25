"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { reviewLinks_save } from "../../app/_generated/actions";
import { EMAIL_TEMPLATE, embedSnippet, renderMessage, SMS_TEMPLATE, smsLength, unknownVariables } from "../../lib/review-requests";
import { CopyButton } from "../agents/copy-button";
import { Badge, buttonClass, ErrorText, inputClass, secondaryButtonClass } from "../ui";

async function save(input: object, setError: (m: string | null) => void, done: () => void) {
  const r = await reviewLinks_save(input);
  if (!r.ok) setError(`${r.error.code}: ${r.error.message}`);
  else {
    setError(null);
    done();
  }
}

export function CreateLinkForm({ locationId, suggested }: { locationId: string; suggested: string | null }) {
  const router = useRouter();
  const t = useTranslations("reviewsTools");
  const [placeId, setPlaceId] = useState(suggested ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await save({ locationId, placeId }, setError, () => router.refresh());
        setBusy(false);
      }}
    >
      <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
        {t("requests.placeId")}
        <input value={placeId} onChange={(e) => setPlaceId(e.target.value)} className={`${inputClass} font-mono`} placeholder="ChIJ..." required />
      </label>
      <p className="text-xs text-muted-foreground">
        {suggested ? t("requests.placeHintSuggested") : t("requests.placeHintNone")}
      </p>
      <div><button type="submit" disabled={busy} className={buttonClass}>{t("requests.createLink")}</button></div>
      <ErrorText message={error} />
    </form>
  );
}

export function WidgetSettings(p: { locationId: string; enabled: boolean; minRating: number; layout: string; origin: string; slug: string }) {
  const router = useRouter();
  const t = useTranslations("reviewsTools");
  const [enabled, setEnabled] = useState(p.enabled);
  const [min, setMin] = useState(p.minRating >= 4 ? 4 : 1);
  const [layout, setLayout] = useState(p.layout);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const embed = embedSnippet(p.origin, p.slug, layout);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="flex items-center gap-2 text-[13px] font-semibold">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t("requests.showOnSite")}
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold">
          {t("requests.lowest")}
          <select value={min} onChange={(e) => setMin(Number(e.target.value))} className={inputClass}>
            <option value={1}>{t("requests.allRatings")}</option>
            <option value={4}>{t("requests.fourUp")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold">
          {t("requests.layout")}
          <select value={layout} onChange={(e) => setLayout(e.target.value)} className={inputClass}>
            <option value="grid">{t("requests.layoutGrid")}</option>
            <option value="list">{t("requests.layoutList")}</option>
            <option value="carousel">{t("requests.layoutCarousel")}</option>
            <option value="badge">{t("requests.layoutBadge")}</option>
          </select>
        </label>
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => save({ locationId: p.locationId, widgetEnabled: enabled, widgetMinRating: min, widgetLayout: layout }, setError, () => { setSaved(true); router.refresh(); })}
        >
          {t("requests.saveWidget")}
        </button>
      </div>
      {saved && <p role="status" className="text-xs text-good">{t("requests.saved")}</p>}
      <ErrorText message={error} />
      <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
        {t("requests.embedCode")}
        <textarea readOnly rows={3} value={embed} className="rounded-md border border-input bg-muted p-2.5 font-mono text-xs" />
      </label>
      <p className="text-xs text-muted-foreground">{t("requests.embedNote")}</p>
      <div><CopyButton text={embed} label={t("requests.copyEmbed")} /></div>
    </div>
  );
}

export function MessageComposer({ locationName, smsLink, emailLink }: { locationName: string; smsLink: string; emailLink: string }) {
  const t = useTranslations("reviewsTools");
  const [kind, setKind] = useState<"sms" | "email">("sms");
  const [text, setText] = useState({ sms: SMS_TEMPLATE, email: EMAIL_TEMPLATE });
  const [copied, setCopied] = useState(false);
  const rendered = renderMessage(text[kind], { location_name: locationName, review_link: kind === "sms" ? smsLink : emailLink });
  const unknown = unknownVariables(text[kind]);
  const len = smsLength(rendered);
  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label={t("requests.msgType")} className="flex self-start rounded-lg bg-secondary p-0.5">
        {(["sms", "email"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => { setKind(k); setCopied(false); }}
            className={`h-7 rounded-md px-2.5 text-xs ${kind === k ? "bg-card font-semibold shadow-card" : "font-medium"}`}>
            {k === "sms" ? t("requests.msgSms") : t("requests.msgEmail")}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
        {t("requests.message")}
        <textarea rows={kind === "sms" ? 3 : 7} value={text[kind]} onChange={(e) => { setText({ ...text, [kind]: e.target.value }); setCopied(false); }} className="rounded-md border border-input bg-card p-2.5 text-sm" />
      </label>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{t("requests.variables", { a: "{location_name}", b: "{review_link}" })}</span>
        {kind === "sms" && <span className="tabular-nums">{len.length} / {len.limit}{len.segments > 1 ? t("requests.sendsAs", { segments: len.segments }) : ""}</span>}
      </div>
      {unknown.length > 0 && <p className="text-xs text-warn">{t("requests.unknownVar", { list: unknown.map((u) => `{${u}}`).join(", ") })}</p>}
      <p className="text-xs text-muted-foreground">{t("requests.preview", { text: rendered })}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={secondaryButtonClass} onClick={async () => { await navigator.clipboard.writeText(rendered); setCopied(true); }}>
          {copied ? t("requests.copied") : t("requests.copyMessage")}
        </button>
        <button type="button" disabled className="inline-flex min-h-(--control-h) items-center rounded-control bg-secondary px-4 text-sm font-semibold text-muted-foreground">{t("requests.sendFrom")}</button>
        <Badge tone="warning">{t("requests.notLive")}</Badge>
        <span className="text-xs font-semibold text-warn">{t("requests.needsProvider")}</span>
      </div>
    </div>
  );
}
