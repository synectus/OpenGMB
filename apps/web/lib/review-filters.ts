import { startOfZonedDay } from "@opengmb/core/time";
import type { TimeFormat } from "./time-format";
import { parseSentiment, parseTopic } from "./review-topics";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar day `n` days after a `YYYY-MM-DD` key (pure calendar math, no zone). */
const addDays = (key: string, n: number) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Date inputs are calendar days in `zone` (the client's): from is inclusive, `to` is the whole day (exclusive next day). */
export function dayRange(zone: string, from?: string, to?: string) {
  const out: { from?: string; to?: string } = {};
  if (from && DAY.test(from)) out.from = startOfZonedDay(from, zone).toISOString();
  if (to && DAY.test(to)) out.to = startOfZonedDay(addDays(to, 1), zone).toISOString();
  return out;
}

/** The sort choices of the reviews list, in the words the page shows. The first is the default. */
export const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "rating_high", label: "Highest rating first" },
  { value: "rating_low", label: "Lowest rating first" },
] as const;
export type ReviewSortValue = (typeof SORT_OPTIONS)[number]["value"];

/** `?sort=` as a reviews.list sort. Anything unknown, or the default, is undefined (core defaults to newest). */
export function parseSort(raw: string | null | undefined): ReviewSortValue | undefined {
  const hit = SORT_OPTIONS.find((o) => o.value === raw);
  return hit && hit.value !== "newest" ? hit.value : undefined;
}

/** `?q=` as a reviews.list search: trimmed, capped at core's limit, undefined when blank. */
export function parseQuery(raw: string | null | undefined): string | undefined {
  return raw?.trim().slice(0, 100).trim() || undefined;
}

const EXPORT_COLUMN_KEYS = ["date", "location", "stars", "reviewer", "review", "reply", "replyDate", "replyState", "needsReply"];
/** Core validates the same list; an unknown key it does not know is refused there. */
export const EXPORT_COLUMN_OPTIONS = [
  { key: "date", label: "Date (UTC)", on: true },
  { key: "location", label: "Location", on: true },
  { key: "stars", label: "Rating", on: true },
  { key: "reviewer", label: "Reviewer name", on: false },
  { key: "review", label: "Review text", on: true },
  { key: "reply", label: "Your reply", on: true },
  { key: "replyState", label: "Reply status", on: true },
  { key: "replyDate", label: "Reply date", on: true },
  { key: "needsReply", label: "Needs reply", on: true },
] as const;

/**
 * The reviews page filters (the same query params as /reviews) as a reviews.export input.
 * `scope=year` ignores the filters and takes the workspace's last 365 days. `cols=1` marks a
 * column pick from the dialog: the `col` values are the columns, and none means an empty list
 * (core refuses it) rather than the nine-column default.
 */
export function exportInputFromParams(p: URLSearchParams, tf: TimeFormat) {
  const get = (k: string) => p.get(k)?.trim() || undefined;
  const columns = get("cols") ? p.getAll("col").filter((c) => EXPORT_COLUMN_KEYS.includes(c)) : undefined;
  if (get("scope") === "year") {
    const from = startOfZonedDay(addDays(tf.today(get("ws")), -365), tf.zone(get("ws")));
    return { workspaceId: get("ws"), from: from.toISOString(), ...(columns ? { columns } : {}) };
  }
  const ratings = p
    .getAll("rating")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 5);
  const replied = get("replied");
  const loc = get("loc");
  return {
    workspaceId: get("ws"),
    locationIds: loc ? [loc] : undefined,
    groupId: get("group"),
    ratings: ratings.length ? ratings : undefined,
    replied: replied === "yes" ? true : replied === "no" ? false : undefined,
    ...dayRange(tf.zone(get("ws")), get("from"), get("to")),
    q: parseQuery(get("q")),
    topic: parseTopic(get("topic")),
    sentiment: parseSentiment(get("sentiment")),
    sort: parseSort(get("sort")),
    columns,
  };
}
