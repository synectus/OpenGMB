"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { reports_share } from "../../app/_generated/actions";
import { useTimeFormat } from "../time-format-provider";
import { filterFieldClass } from "../page-parts";
import { buttonClass, secondaryButtonClass } from "../ui";

/** Choose an expiry, create the link once, show and copy the URL. The URL is never shown again. */
export function ShareBox({ runId, title, workspaceId, options, defaultDays, onClose }: { runId: string; title: string; workspaceId?: string; options: number[]; defaultDays: number; onClose: () => void }) {
  const t = useTranslations("reports");
  const tf = useTimeFormat();
  const router = useRouter();
  const [days, setDays] = useState(options.includes(defaultDays) ? defaultDays : options[0]!);
  const [agreed, setAgreed] = useState(false);
  const [openedAt] = useState(() => Date.now());
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function create() {
    setError(null);
    const r = await reports_share({ runId, expiresInDays: days, businessAgreed: true });
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    setLink(r.data as { url: string; expiresAt: string });
    router.refresh();
  }

  return (
    <section aria-label={link ? t("shareCreated") : t("shareCreate")} className="flex flex-col gap-3 rounded-panel border border-brand bg-brand-tint p-(--panel-p)">
      <div>
        <h2 className="font-display text-base font-bold text-foreground">{link ? t("shareCreated") : t("shareTitle")}</h2>
        <p className="text-sm text-foreground">
          {title}.{link ? ` ${t("copyNow")}` : ""}
        </p>
      </div>
      {!link && (
        <div className="flex flex-col gap-2 rounded-control border border-warn-border bg-warn-bg p-3 text-sm text-foreground">
          <p data-testid="share-notice">{t("shareNotice", { date: tf.date(new Date(openedAt + days * 86_400_000).toISOString(), workspaceId) })}</p>
          <label className="flex items-center gap-2.5 font-semibold">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            {t("shareConfirm")}
          </label>
        </div>
      )}
      {!link ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium text-muted-foreground">
            {t("expiresAfter")}
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={filterFieldClass}>
              {options.map((d) => (
                <option key={d} value={d}>{d === 1 ? t("dayOne") : t("dayMany", { n: d })}</option>
              ))}
            </select>
          </label>
          <button type="button" className={buttonClass} disabled={!agreed} onClick={create}>{t("createLink")}</button>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>{t("cancel")}</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium text-muted-foreground">
            {t("shareTitle")}
            <input readOnly value={link.url} className={`${filterFieldClass} w-full font-mono`} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <button
            type="button"
            className={buttonClass}
            onClick={async () => {
              await navigator.clipboard.writeText(link.url);
              setCopied(true);
            }}
          >
            {t("copy")}
          </button>
          {copied && <span role="status" className="text-sm text-good">{t("copied")}</span>}
          <p className="w-full text-sm text-foreground">{t("expiresOn", { date: tf.date(link.expiresAt, workspaceId) })}</p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("shareAccessNote")}</p>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
    </section>
  );
}
