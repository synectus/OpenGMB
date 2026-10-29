import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { TableWrap, tdClass, thClass } from "../page-parts";
import { TrackKeyword } from "./track-keyword";
import {
  deviceSplit,
  keywordUsers,
  monthSpan,
  tileDelta,
  type KpiDelta,
  type TileDelta,
} from "../../lib/performance";

const TONE: Record<TileDelta["tone"], string> = {
  good: "text-good",
  bad: "text-bad",
  neutral: "text-foreground",
  none: "text-muted-foreground",
};
const ARROW: Record<NonNullable<TileDelta["arrow"]>, string> = {
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  flat: "M5 12h14",
};

export function Delta({ d }: { d: TileDelta }) {
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-semibold ${TONE[d.tone]}`}>
      {d.arrow && (
        <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
          <path d={ARROW[d.arrow]} />
        </svg>
      )}
      {d.text}
    </span>
  );
}

export function Section({ label, title, children, note }: { label: string; title: ReactNode; children: ReactNode; note?: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <h2 className="font-display text-base font-bold text-foreground">{title}</h2>
      {children}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </section>
  );
}

export function KpiTiles({
  tiles,
  selected,
  hrefFor,
}: {
  tiles: (KpiDelta & { label: string })[];
  selected: string;
  hrefFor: (key: string) => string;
}) {
  const tr = useTranslations("performance");
  return (
    <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {tiles.map((t) => {
        const current = t.key === selected;
        return (
          <li key={t.key}>
            <Link
              href={hrefFor(t.key)}
              aria-current={current ? "true" : undefined}
              className={`flex h-full flex-col gap-1 rounded-panel border p-4 shadow-card hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                current ? "border-brand bg-brand-tint" : "border-border bg-card"
              }`}
            >
              <span className="text-sm text-muted-foreground">{t.label}</span>
              <span className="font-display text-2xl font-extrabold tabular-nums text-foreground">{t.total.toLocaleString("en-US")}</span>
              <Delta d={tileDelta(t, tr)} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function DeviceSplit({ metrics }: { metrics: { metric: string; total: number }[] }) {
  const t = useTranslations("performance");
  const rows = deviceSplit(metrics, t);
  return (
    <Section label={t("foundYou")} title={t("foundYou")}>
      {rows.map((d) => (
        <div key={d.name} className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <strong className="text-foreground">
              {d.name} {d.total.toLocaleString("en-US")}
            </strong>
            {d.mobilePct !== null && (
              <span className="text-muted-foreground">
                {t("deviceBreakdown", { mobile: d.mobile.toLocaleString("en-US"), mobilePct: d.mobilePct, desktop: d.desktop.toLocaleString("en-US"), desktopPct: d.desktopPct! })}
              </span>
            )}
          </div>
          {d.mobilePct === null ? (
            <p className="text-sm text-muted-foreground">{t("noImpressions")}</p>
          ) : (
            <div role="img" aria-label={d.label} className="flex h-7 overflow-hidden rounded-md text-xs font-bold tabular-nums">
              <span style={{ width: `${d.mobilePct}%` }} className="flex items-center bg-foreground pl-2 text-background">{d.mobilePct}%</span>
              <span style={{ width: `${d.desktopPct}%` }} className="flex items-center bg-muted-foreground pl-2 text-background">{d.desktopPct}%</span>
            </div>
          )}
        </div>
      ))}
      <div className="flex gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-3 rounded-sm bg-foreground" />{t("mobile")}</span>
        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-3 rounded-sm bg-muted-foreground" />{t("desktop")}</span>
      </div>
    </Section>
  );
}

function Stars({ rating }: { rating: number }) {
  const t = useTranslations("performance");
  const full = Math.round(rating * 2) / 2; // halves, like the canvas
  return (
    <span role="img" aria-label={t("starsAria", { rating })} className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <svg key={i} aria-hidden width="16" height="16" viewBox="0 0 24 24" className="fill-brand stroke-brand" fillOpacity={full >= i ? 1 : full >= i - 0.5 ? 0.5 : 0} strokeWidth={1.5} strokeLinejoin="round">
          <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
        </svg>
      ))}
    </span>
  );
}

export function ActivityPanel({
  a,
  replyHref,
  error,
}: {
  a: { newReviews: number; averageRating: number | null; unreplied: number; postsPublished: number } | null;
  replyHref: string;
  error: string | null;
}) {
  const t = useTranslations("performance");
  const link = "text-sm font-semibold text-brand-text underline underline-offset-2 hover:text-foreground";
  return (
    <Section label={t("activityTitle")} title={t("activityTitle")}>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      {a && (
        <ul className="flex flex-col gap-2 text-sm text-foreground">
          <li><strong className="tabular-nums">{a.newReviews}</strong> {t("newReviews")}</li>
          <li className="flex flex-wrap items-center gap-2">
            {a.averageRating === null ? (
              <span className="text-muted-foreground">{t("noNewReviews")}</span>
            ) : (
              <>
                <span><strong className="tabular-nums">{a.averageRating.toFixed(1)}</strong> {t("averageRating")}</span>
                <Stars rating={a.averageRating} />
              </>
            )}
          </li>
          <li className="flex flex-wrap items-center gap-2">
            <span><strong className="tabular-nums">{a.unreplied}</strong> {t("unreplied")}</span>
            {a.unreplied > 0 && <Link href={replyHref} className={link}>{t("reply")}</Link>}
          </li>
          <li className="flex flex-wrap items-center gap-2">
            <span><strong className="tabular-nums">{a.postsPublished}</strong> {t("postsPublished")}</span>
            <Link href="/posts?view=list" className={link}>{t("openPosts")}</Link>
          </li>
        </ul>
      )}
    </Section>
  );
}

export function KeywordTable({
  months,
  keywords,
  trackLocations,
}: {
  months: string[];
  keywords: { keyword: string; value: number; isLowerBound: boolean; hiddenBelow: number }[];
  /** Locations a keyword can be tracked at (K4); null = the viewer cannot manage trackers, so no link. */
  trackLocations?: { id: string; title: string; addressSummary?: string | null; phone?: string | null }[] | null;
}) {
  const t = useTranslations("performance");
  return (
    <Section
      label={t("topKeywords")}
      title={months.length ? t("topKeywordsSpan", { span: monthSpan(months, t) }) : t("topKeywords")}
      note={t("keywordsNote")}
    >
      {keywords.length === 0 ? (
        <div className="rounded-panel border border-dashed border-input px-6 py-8 text-center">
          <p className="font-display font-bold text-foreground">{t("noKeywordData")}</p>
          <p className="text-sm text-muted-foreground">{t("noKeywordHint")}</p>
        </div>
      ) : (
        <TableWrap>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted">
              <tr>
                <th scope="col" className={thClass}>{t("keyword")}</th>
                <th scope="col" className={`${thClass} text-right`}>{t("uniqueUsers")}</th>
                {trackLocations && <th scope="col" className={`${thClass} text-right`}><span className="sr-only">{t("trackThis")}</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {keywords.map((k) => (
                <tr key={k.keyword}>
                  <td className={tdClass}>{k.keyword}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{keywordUsers(k, t)}</td>
                  {trackLocations && (
                    <td className={`${tdClass} text-right`}>
                      <TrackKeyword keyword={k.keyword} locations={trackLocations} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Section>
  );
}

type Delta3 = Pick<KpiDelta, "total" | "delta" | "deltaPct">;

type Row = {
  locationId: string;
  title: string;
  status: "active" | "inactive";
  needsRelink: boolean;
  lastDataDate: string | null;
  googleAccessDenied: boolean;
  calls: Delta3;
  websiteClicks: Delta3;
  directions: Delta3;
  actions: Delta3;
};

export function ByLocation({ rows, days, error }: { rows: Row[]; days: number; error: string | null }) {
  const t = useTranslations("performance");
  const n = (x: number) => x.toLocaleString("en-US");
  return (
    <Section label={t("byLocation")} title={t("byLocation")} note={t("byLocationNote")}>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      {rows
        .filter((r) => r.needsRelink)
        .map((r) => (
          <p key={r.locationId} className="rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-sm text-warn">
            <span className="font-mono">connection_removed</span>: {t("connectionRemoved", { title: r.title, date: r.lastDataDate ?? t("lastCapture") })}
          </p>
        ))}
      <TableWrap>
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-muted">
            <tr>
              <th scope="col" className={thClass}>{t("location")}</th>
              <th scope="col" className={`${thClass} text-right`}>{t("kpi_calls")}</th>
              <th scope="col" className={`${thClass} text-right`}>{t("kpi_websiteClicks")}</th>
              <th scope="col" className={`${thClass} text-right`}>{t("colDirections")}</th>
              <th scope="col" className={thClass} title={t("vsBeforeTitle", { days })}>{t("vsBefore")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.locationId} className={r.status === "inactive" ? "text-muted-foreground" : "text-foreground"}>
                <td className={tdClass}>
                  <div className="flex flex-col">
                    <Link href={`/locations/${r.locationId}/profile`} className="font-semibold text-brand-text underline underline-offset-2">{r.title}</Link>
                    {r.needsRelink && (
                      <span className="text-xs text-warn">{t("notLinked", { date: r.lastDataDate ?? t("none") })}</span>
                    )}
                    {r.googleAccessDenied && <span className="text-xs text-warn">{t("googleDenied")}</span>}
                  </div>
                </td>
                <td className={`${tdClass} text-right tabular-nums`}>{n(r.calls.total)}</td>
                <td className={`${tdClass} text-right tabular-nums`}>{n(r.websiteClicks.total)}</td>
                <td className={`${tdClass} text-right tabular-nums`}>{n(r.directions.total)}</td>
                <td className={tdClass}>
                  {r.status === "inactive" ? (
                    <span className="inline-flex rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-secondary-foreground">{t("inactive")}</span>
                  ) : (
                    <Delta d={tileDelta(r.actions, t)} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </Section>
  );
}
