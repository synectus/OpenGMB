import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { startOfZonedDay } from "@opengmb/core/time";
import type { TimeFormat } from "../lib/time-format";
import {
  KIND,
  dayCells,
  entryAria,
  entryTime,
  postsHref,
  typeName,
  type CalendarEntry,
  type T,
} from "../lib/posts-lists";

const DAY_MS = 86_400_000;
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
/** Colour is never the only signal: each kind also has a glyph, and projected entries are dashed. */
const KIND_CLASS: Record<CalendarEntry["kind"], string> = {
  scheduled: "border border-info bg-info-bg text-info",
  projected: "border border-dashed border-info bg-card text-info",
  published: "border border-good bg-good text-background",
  failed: "border-2 border-bad bg-bad-bg text-bad",
  skipped: "border border-dotted border-input bg-secondary text-muted-foreground line-through",
  google: "border border-input bg-card text-foreground",
};
const nav =
  "inline-flex size-9 items-center justify-center rounded-control border border-input bg-card text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring";

const monthKey = (d: Date) => d.toISOString().slice(0, 7);
const dayKeyOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The month (YYYY-MM, the client's calendar) and its Monday-first grid. `startKey` is the first day shown;
 * `start` and `end` are the instants the grid covers in the client's zone (`end` exclusive).
 */
export function calendarGrid(month: string | undefined, tf: TimeFormat, ws?: string) {
  const valid = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
  const base = new Date(`${valid ? month : tf.today(ws).slice(0, 7)}-01T00:00:00Z`);
  const first = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const weeks = Math.ceil((offset + days) / 7);
  const startDay = new Date(first.getTime() - offset * DAY_MS);
  const endDay = new Date(startDay.getTime() + weeks * 7 * DAY_MS);
  const zone = tf.zone(ws);
  const shift = (n: number) =>
    monthKey(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + n, 1)));
  return {
    month: monthKey(first),
    startKey: dayKeyOf(startDay),
    weeks,
    start: startOfZonedDay(dayKeyOf(startDay), zone),
    end: startOfZonedDay(dayKeyOf(endDay), zone),
    prev: shift(-1),
    next: shift(1),
  };
}

function Entry({ t, e, ws, wsId, tf }: { t: T; e: CalendarEntry; ws?: string; wsId?: string; tf: TimeFormat }) {
  const aria = entryAria(t, e, tf, wsId);
  if (e.kind === "google") {
    // Made on Google: no SynGMB post to open, so link to the post on Google when Google gave a link.
    const body = (
      <>
        <span aria-hidden>{KIND.google.glyph}</span>
        <span className="truncate font-medium">
          {entryTime(e, tf, wsId)} {typeName(t, e.topicType)}
        </span>
      </>
    );
    const cls = `flex items-center gap-1 rounded px-1 py-0.5 text-xs ${KIND_CLASS.google}`;
    return e.searchUrl ? (
      <a href={e.searchUrl} target="_blank" rel="noreferrer" aria-label={aria} title={aria} className={cls}>
        {body}
      </a>
    ) : (
      <span aria-label={aria} title={aria} className={cls}>
        {body}
      </span>
    );
  }
  return (
    <Link
      href={postsHref({ view: "list", ws, post: e.postId })}
      aria-label={aria}
      title={aria}
      className={`flex items-center gap-1 rounded px-1 py-0.5 text-xs ${KIND_CLASS[e.kind]}`}
    >
      <span aria-hidden>{KIND[e.kind].glyph}</span>
      <span className="truncate font-medium">
        {entryTime(e, tf, wsId)} {typeName(t, e.topicType)}
      </span>
    </Link>
  );
}

/** Month grid (Monday first, in the client's time zone). Entries come from posts.calendar for the grid's range. */
export function PostCalendar({
  t,
  month,
  ws,
  workspaceId,
  tf,
  entries,
  truncated,
  today,
}: {
  t: T;
  month?: string;
  ws?: string;
  /** The client whose zone the grid is in. */
  workspaceId?: string;
  tf: TimeFormat;
  entries: CalendarEntry[];
  truncated: boolean;
  /** YYYY-MM-DD of today in the client's zone, so server and client agree. */
  today: string;
}) {
  const g = calendarGrid(month, tf, workspaceId);
  const cells = dayCells(t, entries, g.startKey, g.weeks, g.month, tf, workspaceId);
  const label = `${t(`cal.month.${Number(g.month.slice(5))}`)} ${g.month.slice(0, 4)}`;
  const zone = tf.label(workspaceId);
  return (
    <section aria-label={t("cal.section")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={postsHref({ view: "calendar", ws, month: g.prev })} aria-label={t("cal.prev")} className={nav}>
          <ChevronLeft aria-hidden className="size-4" />
        </Link>
        <h2 className="font-display text-lg font-bold">{label}</h2>
        <Link href={postsHref({ view: "calendar", ws, month: g.next })} aria-label={t("cal.next")} className={nav}>
          <ChevronRight aria-hidden className="size-4" />
        </Link>
        <span className="text-[13px] text-muted-foreground">{t("cal.timesIn", { zone })}</span>
        <ul aria-label={t("cal.legend")} className="ml-auto flex flex-wrap gap-2 text-xs">
          {(Object.keys(KIND) as CalendarEntry["kind"][]).map((k) => (
            <li key={k} className={`flex items-center gap-1 rounded px-2 py-0.5 ${KIND_CLASS[k]}`}>
              <span aria-hidden>{KIND[k].glyph}</span>
              {t(`kind.${k}`)}
            </li>
          ))}
        </ul>
      </div>
      {truncated && (
        <p role="status" className="text-sm text-warn">
          {t("cal.truncated")}
        </p>
      )}
      <div className="overflow-x-auto">
        <div
          role="grid"
          aria-label={t("cal.gridAria", { label, zone })}
          className="grid min-w-[44rem] grid-cols-7 border-l border-t border-border"
        >
          <div role="row" className="contents">
            {WEEKDAYS.map((d) => (
              <span
                key={d}
                role="columnheader"
                className="border-b border-r border-border bg-muted px-1 py-1 text-center text-xs font-semibold text-muted-foreground"
              >
                {t(`cal.weekday.${d}`)}
              </span>
            ))}
          </div>
          {cells.map((week, w) => (
            <div key={w} role="row" className="contents">
              {week.map((d) => (
                <div
                  key={d.key}
                  role="gridcell"
                  aria-label={d.key}
                  className={`flex min-h-28 flex-col gap-1 border-b border-r border-border p-1 ${d.inMonth ? "bg-card" : "bg-muted"}`}
                >
                  <span
                    className={`w-fit rounded px-1 text-xs ${
                      d.key === today
                        ? "bg-primary font-extrabold text-primary-foreground"
                        : d.inMonth
                          ? "font-semibold text-foreground"
                          : "text-muted-foreground"
                    }`}
                  >
                    {d.num}
                  </span>
                  {d.visible.map((e) => (
                    <Entry key={`${e.postId}-${e.occurrence}-${e.kind}`} t={t} e={e} ws={ws} wsId={workspaceId} tf={tf} />
                  ))}
                  {d.rest.length > 0 && (
                    <details className="flex flex-col gap-1">
                      <summary className="cursor-pointer text-xs font-semibold text-brand-text">
                        {t("cal.more", { count: d.rest.length })}
                      </summary>
                      <div className="mt-1 flex flex-col gap-1">
                        {d.rest.map((e) => (
                          <Entry key={`${e.postId}-${e.occurrence}-${e.kind}`} t={t} e={e} ws={ws} wsId={workspaceId} tf={tf} />
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className="text-[13px] text-muted-foreground">
        {t("cal.footer")}
      </p>
    </section>
  );
}
