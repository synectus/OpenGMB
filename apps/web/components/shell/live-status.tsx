"use client";
import { CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import type { LiveStatus } from "../../lib/live-status";
import { LIVE_STATE } from "../../lib/system-status";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/popover";

export function LiveStatusPill({ status }: { status: LiveStatus }) {
  const t = useTranslations("liveStatus");
  if (status.notLive === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-warn-border bg-warn-bg px-3 text-[13px] font-semibold text-warn focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          <span aria-hidden className="sm:hidden">
            {status.notLive}
          </span>
          <span className="sr-only sm:not-sr-only">
            {t("partsNotLive", { count: status.notLive })}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label={t("title")} className="w-[min(92vw,640px)] p-0">
        <p className="border-b border-border px-4 py-3 font-display text-base font-bold">
          {t("title")}
        </p>
        <ul>
          {status.rows.map((r) => (
            <li
              key={r.key}
              className="grid gap-x-3 gap-y-1 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[170px_110px_minmax(0,1fr)]"
            >
              <span className="text-sm font-semibold">{t(`rows.${r.key}`)}</span>
              <span>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${LIVE_STATE[r.state].className}`}
                >
                  <span aria-hidden className="size-1.5 rounded-full bg-current" />
                  {t(`states.${r.state}`)}
                </span>
              </span>
              <span className="text-sm text-muted-foreground">
                {r.detail}
                {r.setting ? ` ${t("setting", { name: r.setting })}` : null}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function LiveStatusBanner({ banner }: { banner: string | null }) {
  const t = useTranslations("liveStatus");
  if (!banner) return null;
  return (
    <aside
      aria-label={t("serverStatus")}
      className="flex h-9 items-center gap-2 border-b border-warn-border bg-warn-bg px-3 text-[13px] leading-5 text-warn sm:px-5"
    >
      <CircleAlert aria-hidden className="size-4 shrink-0" />
      <p className="min-w-0 truncate" title={banner}>
        {banner}
      </p>
    </aside>
  );
}
