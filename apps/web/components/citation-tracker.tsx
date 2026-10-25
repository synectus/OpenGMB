"use client";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { citations_addCustom, citations_check, citations_checkAll, citations_deleteCustom, citations_save } from "../app/_generated/actions";
import {
  CITATION_STATUSES,
  livePercent,
  matchesFilter,
  summarize,
  type CitationStatus,
  type StatusFilter,
} from "../lib/citations";
import { Pill } from "./page-parts";
import { runCall } from "./post-card";
import { buttonClass, destructiveButtonClass, inputClass, secondaryButtonClass } from "./ui";

export type CitationEntry = {
  id: string;
  status: CitationStatus;
  listingUrl: string | null;
  emailUsed: string | null;
  nameUsed: string | null;
  addressUsed: string | null;
  phoneUsed: string | null;
  submittedOn: string | null;
  notes: string | null;
  checkedAt: string | null;
  checkResult: CheckResult | null;
  checkFields: { name?: string; address?: string; phone?: string } | null;
  checkReason: string | null;
};
export type CitationSiteRow = {
  key: string;
  name: string;
  claimUrl: string;
  cost: "free" | "paid";
  type: "core" | "general" | "social" | "maps";
  priority: number;
  entry: CitationEntry | null;
};
export type CitationCustomRow = { name: string; url: string | null; entry: CitationEntry };
type Defaults = { name: string; address: string; phone: string };

export type CheckResult = "match" | "mismatch" | "not_found" | "could_not_fetch";
const CHECK_TONE = { match: "good", mismatch: "bad", not_found: "warn", could_not_fetch: "neutral" } as const;
const TONE = { not_started: "neutral", submitted: "info", live: "good", needs_fix: "warn" } as const;

function CodeError({ message }: { message: string | null }) {
  if (!message) return null;
  const at = message.indexOf(":");
  return (
    <p role="alert" className="text-[13px] text-bad">
      <span className="font-mono">{message.slice(0, at)}</span>
      {message.slice(at)}
    </p>
  );
}

function CheckNote({ entry, name, locale }: { entry: CitationEntry; name: string; locale: string }) {
  const t = useTranslations("locationHub.citations");
  const result = entry.checkResult!;
  const differing = (["name", "address", "phone"] as const).filter((f) => entry.checkFields?.[f] === "mismatch");
  const date = entry.checkedAt ? new Date(entry.checkedAt).toLocaleDateString(locale, { dateStyle: "medium" }) : null;
  const text =
    result === "mismatch"
      ? t("differs", { fields: differing.map((f) => t(`field.${f}`)).join(", ") })
      : result === "not_found"
        ? t(entry.checkReason === "page_gone" ? "pageGone" : "notFoundHelp")
        : result === "could_not_fetch"
          ? t("couldNotHelp")
          : null;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
      {text && <span>{text}</span>}
      {result !== "match" && entry.listingUrl && (
        <a
          href={entry.listingUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={t("openListingFor", { name })}
          className="font-semibold text-brand-text underline underline-offset-2 hover:text-foreground"
        >
          {t("openListing")}
        </a>
      )}
      {date && <span>{t("checkedOn", { date })}</span>}
    </p>
  );
}

type RowItem = {
  rowKey: string;
  name: string;
  url: string | null;
  cost?: "free" | "paid";
  type?: CitationSiteRow["type"];
  priority?: number;
  custom: boolean;
  siteKey?: string;
  entry: CitationEntry | null;
};

function Row({
  item,
  locationId,
  canEdit,
  defaults,
  onSaved,
  onRemoved,
}: {
  item: RowItem;
  locationId: string;
  canEdit: boolean;
  defaults: Defaults;
  onSaved: (e: CitationEntry) => void;
  onRemoved: (id: string) => void;
}) {
  const t = useTranslations("locationHub.citations");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const status: CitationStatus = item.entry?.status ?? "not_started";

  async function save(patch: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setSaved(false);
    const who = item.custom ? { id: item.entry!.id } : { siteKey: item.siteKey };
    const r = await runCall<{ entry: CitationEntry }>(() => citations_save({ locationId, ...who, ...patch }));
    setBusy(false);
    if ("error" in r) return setError(r.error);
    setSaved(true);
    onSaved(r.data.entry);
  }

  async function check() {
    setChecking(true);
    setError(null);
    const who = item.custom ? { id: item.entry!.id } : { siteKey: item.siteKey };
    const r = await runCall<{ entry: CitationEntry }>(() => citations_check({ locationId, ...who }));
    setChecking(false);
    if ("error" in r) return setError(r.error);
    onSaved(r.data.entry);
  }

  async function remove() {
    if (!window.confirm(t("confirmRemove", { name: item.name }))) return;
    setBusy(true);
    const r = await runCall<{ deleted: true }>(() => citations_deleteCustom({ id: item.entry!.id }));
    setBusy(false);
    if ("error" in r) return setError(r.error);
    onRemoved(item.entry!.id);
  }

  function submitDetails(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? "");
    void save({
      listingUrl: v("listingUrl"),
      emailUsed: v("emailUsed"),
      nameUsed: v("nameUsed"),
      addressUsed: v("addressUsed"),
      phoneUsed: v("phoneUsed"),
      submittedOn: v("submittedOn") || null,
      notes: v("notes"),
    });
  }

  const e = item.entry;
  const field = (name: keyof CitationEntry, label: string, extra: { type?: string; placeholder?: string } = {}) => (
    <label className="flex min-w-0 flex-col gap-1 text-[13px] font-medium">
      {label}
      <input
        name={name}
        type={extra.type ?? "text"}
        defaultValue={(e?.[name] as string | null) ?? ""}
        placeholder={extra.placeholder}
        disabled={!canEdit}
        className={inputClass}
      />
    </label>
  );

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
          <span className="font-semibold">{item.name}</span>
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {item.cost && <span>{t(item.cost)}</span>}
            {item.type && <span>{t(`type.${item.type}`)}</span>}
            {item.priority && <span>{t(`priority.${item.priority}`)}</span>}
          </span>
        </div>
        <Pill tone={TONE[status]}>{t(`status.${status}`)}</Pill>
        {item.entry?.checkResult && <Pill tone={CHECK_TONE[item.entry.checkResult]}>{t(`checkResult.${item.entry.checkResult}`)}</Pill>}
        <select
          aria-label={t("statusFor", { name: item.name })}
          value={status}
          disabled={busy || !canEdit}
          onChange={(ev) => void save({ status: ev.target.value })}
          className={inputClass}
        >
          {CITATION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>
        {item.url && (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            aria-label={t("openSiteFor", { name: item.name })}
            className="text-sm font-semibold text-brand-text underline underline-offset-2 hover:text-foreground"
          >
            {t("openSite")}
          </a>
        )}
      </div>
      {item.entry?.checkResult && <CheckNote entry={item.entry} name={item.name} locale={locale} />}
      {canEdit && item.entry?.listingUrl && (
        <div>
          <button
            type="button"
            aria-label={t("checkListingFor", { name: item.name })}
            className={`${secondaryButtonClass} min-h-9`}
            disabled={checking || busy}
            onClick={() => void check()}
          >
            {checking ? t("checking") : t("checkListing")}
          </button>
        </div>
      )}
      <details className="rounded-control border border-border px-3 py-2">
        <summary aria-label={t("detailsFor", { name: item.name })} className="cursor-pointer text-sm font-medium">
          {t("details")}
        </summary>
        <form key={e?.id ?? "new"} onSubmit={submitDetails} className="mt-3 grid gap-3 sm:grid-cols-2">
          {field("listingUrl", t("listingUrl"), { type: "url", placeholder: "https://" })}
          {field("emailUsed", t("emailUsed"), { type: "email" })}
          {field("nameUsed", t("nameUsed"), { placeholder: defaults.name })}
          {field("addressUsed", t("addressUsed"), { placeholder: defaults.address })}
          {field("phoneUsed", t("phoneUsed"), { type: "tel", placeholder: defaults.phone })}
          {field("submittedOn", t("submittedOn"), { type: "date" })}
          <label className="flex flex-col gap-1 text-[13px] font-medium sm:col-span-2">
            {t("notes")}
            <textarea name="notes" defaultValue={e?.notes ?? ""} disabled={!canEdit} rows={2} className={`${inputClass} py-2`} />
          </label>
          {canEdit && (
            <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
              <button type="submit" className={buttonClass} disabled={busy}>
                {busy ? t("saving") : t("save")}
              </button>
              {saved && !busy && (
                <span role="status" className="text-[13px] text-good">
                  {t("saved")}
                </span>
              )}
              {item.custom && (
                <button
                  type="button"
                  aria-label={t("removeFor", { name: item.name })}
                  className={destructiveButtonClass}
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {t("remove")}
                </button>
              )}
            </div>
          )}
        </form>
      </details>
      <CodeError message={error} />
    </li>
  );
}

export function CitationTracker({
  locationId,
  canEdit,
  country,
  countries,
  countryFallback,
  verifiedOn,
  defaults,
  sites: initialSites,
  custom: initialCustom,
}: {
  locationId: string;
  canEdit: boolean;
  country: string;
  countries: string[];
  countryFallback: boolean;
  verifiedOn: string;
  defaults: Defaults;
  sites: CitationSiteRow[];
  custom: CitationCustomRow[];
}) {
  const t = useTranslations("locationHub.citations");
  const locale = useLocale();
  const router = useRouter();
  const [sites, setSites] = useState(initialSites);
  const [custom, setCustom] = useState(initialCustom);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);

  const items: RowItem[] = [
    ...sites.map((s) => ({
      rowKey: s.key, name: s.name, url: s.claimUrl, cost: s.cost, type: s.type, priority: s.priority,
      custom: false, siteKey: s.key, entry: s.entry,
    })),
    ...custom.map((c) => ({ rowKey: c.entry.id, name: c.name, url: c.url, custom: true, entry: c.entry as CitationEntry | null })),
  ];
  const statusOf = (i: RowItem): CitationStatus => i.entry?.status ?? "not_started";
  const sum = summarize(items.map(statusOf));
  const shown = items.filter((i) => matchesFilter(statusOf(i), filter));
  const regionName = (c: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: "region" }).of(c) ?? c;
    } catch {
      return c;
    }
  };
  const liveItems = items.filter((i) => statusOf(i) === "live");
  const liveChecked = (r: CheckResult) => liveItems.filter((i) => i.entry?.checkResult === r).length;
  const checkable = liveItems.filter((i) => i.entry?.listingUrl).length;
  const count = (f: StatusFilter) => (f === "all" ? sum.total : f === "live" ? sum.live : f === "submitted" ? sum.submitted : f === "needs_fix" ? sum.needsFix : sum.notStarted);

  function saved(e: CitationEntry, item: RowItem) {
    if (item.custom) setCustom((cs) => cs.map((c) => (c.entry.id === e.id ? { ...c, entry: e } : c)));
    else setSites((ss) => ss.map((s) => (s.key === item.siteKey ? { ...s, entry: e } : s)));
  }

  async function checkAll() {
    setCheckingAll(true);
    setCheckError(null);
    setRemaining(0);
    const r = await runCall<{ entries: (CitationEntry & { id: string })[]; remaining: number }>(() => citations_checkAll({ locationId }));
    setCheckingAll(false);
    if ("error" in r) return setCheckError(r.error);
    const byId = new Map(r.data.entries.map((e) => [e.id, e]));
    setSites((ss) => ss.map((s) => (s.entry && byId.has(s.entry.id) ? { ...s, entry: byId.get(s.entry.id)! } : s)));
    setCustom((cs) => cs.map((c) => (byId.has(c.entry.id) ? { ...c, entry: byId.get(c.entry.id)! } : c)));
    setRemaining(r.data.remaining);
  }

  async function addCustom(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    const r = await runCall<{ custom: CitationCustomRow }>(() =>
      citations_addCustom({ locationId, name, ...(url.trim() ? { url: url.trim() } : {}) }),
    );
    setBusy(false);
    if ("error" in r) return setError(r.error);
    setCustom((cs) => [...cs, r.data.custom]);
    setName("");
    setUrl("");
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-2xl flex-col gap-1">
        <h2 className="font-display text-lg font-bold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
        <p className="text-sm font-medium">{t("passwordHint")}</p>
        {!canEdit && <p className="text-[13px] text-muted-foreground">{t("readOnly")}</p>}
      </div>

      <section aria-label={t("progressAria")} className="flex flex-col gap-2 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
        <p className="text-sm font-semibold tabular-nums">{t("progress", { live: sum.live, total: sum.total })}</p>
        <div
          role="progressbar"
          aria-label={t("progressAria")}
          aria-valuemin={0}
          aria-valuemax={sum.total}
          aria-valuenow={sum.live}
          className="h-2 w-full overflow-hidden rounded-full bg-secondary"
        >
          <div className="h-full bg-good" style={{ width: `${livePercent(sum.live, sum.total)}%` }} />
        </div>
        <p className="text-[13px] tabular-nums text-muted-foreground">
          {t("progressDetail", { submitted: sum.submitted, needsFix: sum.needsFix, notStarted: sum.notStarted })}
        </p>
      </section>

      <section aria-label={t("checkAll")} className="flex flex-col gap-2 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
        <p className="text-sm text-muted-foreground">{t("checkIntro")}</p>
        {sum.live > 0 && (
          <>
            <p className="text-sm font-semibold tabular-nums">{t("checkSummary", { match: liveChecked("match"), total: sum.live })}</p>
            <p className="text-[13px] tabular-nums text-muted-foreground">
              {t("checkSummaryDetail", {
                mismatch: liveChecked("mismatch"),
                notFound: liveChecked("not_found"),
                couldNot: liveChecked("could_not_fetch"),
                unchecked: liveItems.filter((i) => !i.entry?.checkResult).length,
              })}
            </p>
          </>
        )}
        {canEdit && checkable > 0 ? (
          <div>
            <button type="button" className={buttonClass} disabled={checkingAll} onClick={() => void checkAll()}>
              {checkingAll ? t("checking") : t("checkAll")}
            </button>
          </div>
        ) : (
          checkable === 0 && <p className="text-[13px] text-muted-foreground">{t("checkNone")}</p>
        )}
        {remaining > 0 && <p role="status" className="text-[13px] text-info">{t("checkRemaining", { count: remaining })}</p>}
        <CodeError message={checkError} />
      </section>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div role="group" aria-label={t("filterAria")} className="flex flex-wrap gap-2">
          {(["all", ...CITATION_STATUSES] as StatusFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`${filter === f ? buttonClass : secondaryButtonClass} min-h-9`}
            >
              {f === "all" ? t("filterAll", { count: count(f) }) : t("filterItem", { label: t(`status.${f}`), count: count(f) })}
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          {t("countryLabel")}
          <select
            value={country}
            onChange={(ev) => router.push(`?country=${ev.target.value}`)}
            className={inputClass}
          >
            {countries.map((c) => (
              <option key={c} value={c}>
                {regionName(c)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {countryFallback && <p role="status" className="text-[13px] text-info">{t("countryFallback", { country: regionName(country) })}</p>}

      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("none")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-panel border border-border bg-card px-(--panel-p) shadow-card">
          {shown.map((i) => (
            <Row
              key={`${country}-${i.rowKey}`}
              item={i}
              locationId={locationId}
              canEdit={canEdit}
              defaults={defaults}
              onSaved={(e) => saved(e, i)}
              onRemoved={(id) => setCustom((cs) => cs.filter((c) => c.entry.id !== id))}
            />
          ))}
        </ul>
      )}

      {canEdit && (
        <form onSubmit={addCustom} className="flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
          <h3 className="font-display text-base font-bold">{t("customTitle")}</h3>
          <p className="text-sm text-muted-foreground">{t("customIntro")}</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-[13px] font-medium">
              {t("customName")}
              <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} className={inputClass} />
            </label>
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-[13px] font-medium">
              {t("customUrl")}
              <input value={url} onChange={(e) => setUrl(e.target.value)} type="url" placeholder="https://" className={inputClass} />
            </label>
            <button type="submit" className={buttonClass} disabled={busy || !name.trim()}>
              {t("add")}
            </button>
          </div>
          <CodeError message={error} />
        </form>
      )}
      <p className="text-xs text-muted-foreground">{t("listChecked", { date: verifiedOn })}</p>
    </div>
  );
}
