// Pure logic for the Posts views Approval queue, All posts, Calendar and On Google. Client-safe:
// only types come from core (erased at build); the one runtime import is the pure @opengmb/core/time.
import type { postsCalendar, postsGet, postsGoogleList } from "@opengmb/core";
import { enumLabel, statusWords } from "./labels";
import { localParts, wallToUtc, zonedWallToUtc } from "@opengmb/core/time";
import type { TimeFormat } from "./time-format";
import { failureLabel } from "./failure-labels";

type Out<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
/** A translator for the `posts` namespace (next-intl's `t`, from useTranslations or getTranslations). */
export type T = {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
};
/** A post status as lower-case words, in the reader's language; unknown statuses fall back to English. */
export const statusText = (t: T, status: string): string =>
  t.has(`status.${status}`) ? t(`status.${status}`) : statusWords(status);
/** A Google call-to-action button name, in the reader's language. */
export const ctaName = (t: T, actionType: string): string =>
  t.has(`cta.${actionType}`) ? t(`cta.${actionType}`) : enumLabel(actionType);
/** The longer button name used where a post's button is shown, e.g. "Order online". */
export const ctaFullName = (t: T, actionType: string): string =>
  t.has(`ctaFull.${actionType}`) ? t(`ctaFull.${actionType}`) : enumLabel(actionType);
export type PostView = Out<typeof postsGet>["post"];
export type CalendarEntry = Out<typeof postsCalendar>["entries"][number];
export type GooglePost = Out<typeof postsGoogleList>["posts"][number];

export const POST_TYPES = ["STANDARD", "EVENT", "OFFER", "ALERT"] as const;
export type PostType = (typeof POST_TYPES)[number];
export const typeName = (t: T, type: string): string =>
  t.has(`type.${type}`) ? t(`type.${type}`) : enumLabel(type);
export const parseType = (v: string | undefined): PostType | undefined =>
  POST_TYPES.find((t) => t === v);

export const POST_STATUSES = [
  "draft",
  "blocked",
  "pending_approval",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "cancelled",
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];
export const parseStatus = (v: string | undefined): PostStatus | undefined =>
  POST_STATUSES.find((s) => s === v);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string | undefined): v is string => v !== undefined && UUID.test(v);

export function postsHref(o: {
  view: string;
  ws?: string;
  type?: string;
  status?: string;
  q?: string;
  post?: string;
  month?: string;
  loc?: string;
}): string {
  const p = new URLSearchParams({ view: o.view });
  for (const k of ["ws", "type", "status", "q", "post", "month", "loc"] as const) {
    const v = o[k];
    if (v) p.set(k, v);
  }
  return `/posts?${p.toString()}`;
}

/** "All 3", "Standard 1", ... counted over the whole list, whatever the current filter is. */
export function typePills(t: T, posts: { topicType: string }[], current: PostType | undefined) {
  const count = (pt: PostType) => posts.filter((p) => p.topicType === pt).length;
  return [
    { key: "ALL" as const, label: `All ${posts.length}`, current: current === undefined },
    ...POST_TYPES.map((pt) => ({ key: pt, label: `${typeName(t, pt)} ${count(pt)}`, current: current === pt })),
  ];
}

export function nextSendCell(t: T, p: PostView, tf: TimeFormat): string {
  switch (p.status) {
    case "scheduled":
      return p.scheduledFor ? tf.dateTime(p.scheduledFor, p.workspaceId) : "·";
    case "publishing":
      return t("card.nextSendNow");
    case "approved":
      return t("card.notScheduled");
    case "pending_approval":
      return t("card.afterApproval");
    case "published": {
      const last = p.targets
        .map((t) => t.publishedAt)
        .filter((v): v is string => !!v)
        .sort()
        .at(-1);
      return last ? t("card.sentOn", { date: tf.date(last, p.workspaceId) }) : "·";
    }
    default:
      return "·";
  }
}

/** Locations of the current send (all sends once it is over). */
function currentTargets(p: PostView) {
  const now = p.targets.filter((t) => t.occurrence === p.occurrence);
  return now.length > 0 ? now : p.targets;
}
export function locationsCell(t: T, p: PostView, totalActive?: number): string {
  const n = new Set(currentTargets(p).map((x) => x.locationId)).size;
  return totalActive ? t("card.locationsOf", { n, total: totalActive }) : String(n);
}
export function locationsLine(p: PostView): string {
  const names = [...new Set(currentTargets(p).map((t) => t.locationName))].sort();
  return `${names.join(", ")} · ${names.length} location${names.length === 1 ? "" : "s"}`;
}

/** "send 3 of 6" for a recurring post (core's occurrence is 0-based; count includes the first). */
export function sendNumber(t: T, p: PostView): string | null {
  if (!p.recurrence) return null;
  const n = p.occurrence + 1;
  return p.recurrence.count !== undefined ? t("card.sendNumberOf", { n, count: p.recurrence.count }) : t("card.sendNumber", { n });
}

export const authorLabel = (t: T, p: PostView): string =>
  p.createdSurface === "mcp" ? t("card.authorAgent") : (p.createdByName ?? t("card.authorFallback"));
const draftedLine = (t: T, p: PostView): string =>
  p.createdSurface === "mcp"
    ? t("card.draftedAgent")
    : t("card.draftedBy", { name: p.createdByName ?? t("card.teamMemberLower") });

/** First line of the event title or the text, cut for a table cell. */
export function postTitle(t: T, p: PostView, max = 70): string {
  const raw = (p.event?.title || p.summary || t("common.noText")).replace(/\s+/g, " ").trim();
  return raw.length > max ? `${raw.slice(0, max - 1).trimEnd()}…` : raw;
}

/** Title of a post made on Google (posts.list googleOnly), cut for a table cell. */
export function googlePostTitle(t: T, g: { eventTitle: string | null; summary: string }, max = 70): string {
  const raw = (g.eventTitle || g.summary || t("common.noText")).replace(/\s+/g, " ").trim();
  return raw.length > max ? `${raw.slice(0, max - 1).trimEnd()}…` : raw;
}

const CTA_NAME: Record<string, string> = {
  BOOK: "Book",
  ORDER: "Order",
  SHOP: "Shop",
  LEARN_MORE: "Learn more",
  SIGN_UP: "Sign up",
  CALL: "Call",
};
export function ctaLine(p: PostView): string {
  if (!p.cta) return "No button";
  const label = CTA_NAME[p.cta.actionType] ?? enumLabel(p.cta.actionType);
  if (p.topicType === "OFFER") return `${label}: kept, but Google will not show it on an offer`;
  if (p.cta.actionType === "CALL") return `${label} · uses the location's phone`;
  return p.cta.url ? `${label} · ${p.cta.url}` : label;
}

export function languageLine(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    return name && name !== code ? `${name} (${code})` : code;
  } catch {
    return code;
  }
}

export type TargetRow = {
  id: string;
  location: string;
  occurrence: string;
  status: string;
  reason: string;
  googleHref: string | null;
};
/** Rows of the "Results per location" table. A pending target of a publishing post is publishing. */
export function targetRows(p: PostView, tf: TimeFormat): TargetRow[] {
  return p.targets.map((t) => ({
    id: t.id,
    location: t.locationName,
    occurrence: `${t.occurrence + 1}${t.publishedAt ? ` · ${tf.dateTime(t.publishedAt, p.workspaceId)}` : ""}`,
    status: t.status === "pending" && p.status === "publishing" ? "publishing" : t.status,
    reason: t.error ? failureLabel(t.error) : "",
    googleHref:
      t.status === "published" && t.googlePostName
        ? postsHref({ view: "google", loc: t.locationId })
        : null,
  }));
}

export type Tone = "agent" | "plain" | "warn" | "good" | "bad" | "info" | "neutral";
export type CardState = {
  provenance: { text: string; tone: Tone } | null;
  note: { text: string; tone: Tone } | null;
  /** Small line under the actions. */
  foot: string | null;
  /** Next send or sent line next to the badges. */
  meta: string | null;
  schedule: boolean;
};

/** What a post card says in each state; buttons come from `post.can` in the component. */
export function cardState(t: T, p: PostView, tf: TimeFormat): CardState {
  const at = (iso: string | null) => (iso ? tf.dateTime(iso, p.workspaceId) : "");
  const agent = p.createdSurface === "mcp";
  const drafted = { text: t("card.draftedAt", { who: draftedLine(t, p), date: at(p.createdAt) }), tone: agent ? ("agent" as const) : ("plain" as const) };
  const none: CardState = { provenance: null, note: null, foot: null, meta: null, schedule: false };
  const by = (key: string, plain: string, name: string | null) => (name ? t(key, { name }) : plain);
  switch (p.status) {
    case "draft":
      if (p.rejectReason) {
        return {
          ...none,
          provenance: {
            text: p.rejectedByName
              ? t("card.rejectedBy", { name: p.rejectedByName, reason: p.rejectReason })
              : t("card.rejected", { reason: p.rejectReason }),
            tone: "warn",
          },
          foot: t("card.fixAndSubmit"),
        };
      }
      return {
        ...none,
        provenance: drafted,
        foot: agent ? t("card.checkAndSubmit") : t("card.notSentYet"),
      };
    case "blocked":
      return {
        ...none,
        provenance: drafted,
        note: { text: t("note.blocked"), tone: "bad" },
        foot: t("card.blockedFoot"),
      };
    case "pending_approval":
      return {
        ...none,
        provenance: {
          text: t("card.draftedSubmitted", { who: draftedLine(t, p), date: at(p.submittedAt) }),
          tone: agent ? "agent" : "plain",
        },
        note:
          p.can.approve || p.can.reject
            ? null
            : { text: t("card.readOnlyApprove"), tone: "neutral" },
      };
    case "approved":
      return {
        ...none,
        provenance: { text: `${by("card.approvedBy", t("card.approved"), p.approvedByName)} · ${at(p.approvedAt)}`, tone: "good" },
        schedule: p.can.schedule,
        note: p.can.schedule
          ? null
          : { text: t("card.approvedNote"), tone: "neutral" },
      };
    case "scheduled": {
      const rec = p.recurrence;
      const parts = [
        t("card.nextSend", { date: at(p.scheduledFor) }),
        rec ? t("card.repeats", { freq: t(`sched.${rec.freq}`), interval: rec.interval }) : null,
        sendNumber(t, p),
      ].filter(Boolean);
      return {
        ...none,
        provenance: agent ? drafted : null,
        meta: parts.join(" · "),
        foot: rec ? t("card.cancelStopsSeries") : t("card.sentWithinMinute"),
      };
    }
    case "publishing":
      return { ...none, note: { text: t("card.publishingNote"), tone: "info" } };
    case "published": {
      const done = p.targets.filter((x) => x.status === "published");
      const failed = p.targets.filter((x) => x.status === "failed");
      const last = done.map((x) => x.publishedAt).filter((v): v is string => !!v).sort().at(-1);
      const sent = last ? t("card.sentOn", { date: at(last) }) : null;
      const some = failed.length > 0 ? t("card.partPublished", { done: done.length, total: done.length + failed.length }) : null;
      const reconnect = failed.filter((x) => x.error === "connection_removed").map((x) => x.locationName);
      return {
        ...none,
        meta: [sent, some].filter(Boolean).join(" · ") || null,
        foot: reconnect.length > 0 ? t("card.reconnect", { names: [...new Set(reconnect)].join(", ") }) : null,
      };
    }
    case "failed": {
      const codes = p.targets.filter((x) => x.status === "failed").map((x) => x.error);
      const text = codes.every((c) => c === "google_writes_disabled") && codes.length > 0
        ? { text: t("card.failedWritesOff"), tone: "warn" as const }
        : codes.includes("missing_scope")
          ? { text: t("card.failedScope"), tone: "bad" as const }
          : { text: t("card.failedOther"), tone: "bad" as const };
      return {
        ...none,
        note: text,
        foot: t("card.failedFoot"),
      };
    }
    case "cancelled":
      return {
        ...none,
        provenance: {
          text: `${by("card.cancelledBy", t("card.cancelled"), p.cancelledByName)} · ${at(p.cancelledAt)}.${p.recurrence ? ` ${t("card.seriesStopped")}` : ""}`,
          tone: "neutral",
        },
      };
  }
}

export type ScheduleDraft = {
  mode: "now" | "at" | "recurring";
  /** datetime-local value, wall time in the post's zone. */
  at: string;
  freq: "weekly" | "monthly";
  interval: number;
  ends: "count" | "until";
  count: number;
  /** date input value. */
  until: string;
  locations: number;
};

const p2 = (n: number) => String(n).padStart(2, "0");
const keyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The sentence under the schedule form. Mirrors only the maths that is exact; null until the start is valid. `at` and `until` are read in the client's zone. */
export function describeSchedule(t: T, d: ScheduleDraft, tf: TimeFormat, ws?: string): string | null {
  const where = t("sched.where", { count: d.locations });
  const late = t("sched.late");
  if (d.mode === "now") return t("sched.sendsNow", { where, late });
  const zone = tf.zone(ws);
  const start = zonedWallToUtc(d.at, zone);
  if (!d.at || !start) return null;
  const l = localParts(start, zone);
  const day = tf.date(start, ws);
  const time = `${p2(l.hour)}:${p2(l.minute)} ${tf.label(ws, start)}`;
  if (d.mode === "at") return t("sched.sendsAt", { day, time, where, late });
  const n = Math.max(1, d.interval);
  const weekday = t(`sched.weekday.${l.weekday}`);
  const cadence =
    d.freq === "weekly"
      ? n === 1
        ? t("sched.cadenceWeekly", { weekday, time })
        : t("sched.cadenceWeeklyN", { n, weekday, time })
      : n === 1
        ? t("sched.cadenceMonthly", { day: l.day, time })
        : t("sched.cadenceMonthlyN", { n, day: l.day, time });
  if (d.ends === "until") {
    if (!d.until) return null;
    const lead = cadence.charAt(0).toUpperCase() + cadence.slice(1);
    return t("sched.untilSentence", { lead, day, end: tf.day(d.until, ws), where, late });
  }
  if (d.freq === "weekly") {
    const last = keyOf(Date.UTC(l.year, l.month - 1, l.day + (d.count - 1) * n * 7));
    return t("sched.countWeekly", { count: d.count, cadence, day, last: tf.day(last, ws), where, late });
  }
  return t("sched.countMonthly", { count: d.count, cadence, day, where, late });
}

/**
 * The action input for the schedule form. `at` (datetime-local) and `until` (date, inclusive) are wall
 * time in the post's zone; the action still takes instants, so they are converted here.
 */
export function scheduleInput(
  t: T,
  d: Omit<ScheduleDraft, "locations">,
  id: string,
  zone: string,
): { input: Record<string, unknown> } | { error: string } {
  if (d.mode === "now") return { input: { id } };
  const start = zonedWallToUtc(d.at, zone);
  if (!start) return { error: t("sched.errStart") };
  const scheduledFor = start.toISOString();
  if (d.mode === "at") return { input: { id, scheduledFor } };
  if (d.ends === "until" && !d.until) return { error: t("sched.errEnd") };
  const [y, m, day] = d.until.split("-").map(Number) as [number, number, number];
  return {
    input: {
      id,
      scheduledFor,
      recurrence: {
        freq: d.freq,
        interval: d.interval,
        ...(d.ends === "until" ? { until: wallToUtc(y, m, day, 23, 59, zone, 59).toISOString() } : { count: d.count }),
      },
    },
  };
}

/** The glyph of each calendar entry kind; its name is `kind.<kind>` in the posts messages. */
export const KIND = {
  scheduled: { glyph: "●" },
  projected: { glyph: "○" },
  published: { glyph: "✓" },
  failed: { glyph: "!" },
  skipped: { glyph: "–" },
  google: { glyph: "G" },
} as const;
export const DAY_VISIBLE = 3;

export const entryTime = (e: CalendarEntry, tf: TimeFormat, ws?: string): string => tf.time(e.at, ws ?? e.workspaceId); // across clients, each entry reads in its own client's zone
export const entryAria = (t: T, e: CalendarEntry, tf: TimeFormat, ws?: string): string =>
  t("cal.entryAria", {
    time: entryTime(e, tf, ws),
    type: typeName(t, e.topicType),
    kind: e.kind === "google" ? t("kind.google") : t(`kindLower.${e.kind}`),
    preview: e.summaryPreview,
  });

export type DayCell = {
  key: string;
  num: string;
  inMonth: boolean;
  visible: CalendarEntry[];
  rest: CalendarEntry[];
};
/** `weeks` rows of 7 days from `startKey` (a Monday, YYYY-MM-DD) in the client's zone. Days outside `month` (YYYY-MM) carry their month in the label. */
export function dayCells(
  t: T,
  entries: CalendarEntry[],
  startKey: string,
  weeks: number,
  month: string,
  tf: TimeFormat,
  ws?: string,
): DayCell[][] {
  const byDay = new Map<string, CalendarEntry[]>();
  for (const e of [...entries].sort((a, b) => a.at.localeCompare(b.at))) {
    const k = tf.dayKey(e.at, ws ?? e.workspaceId);
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }
  const [y, m, d0] = startKey.split("-").map(Number) as [number, number, number];
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => {
      const d = new Date(Date.UTC(y, m - 1, d0 + w * 7 + i));
      const key = keyOf(d.getTime());
      const inMonth = key.slice(0, 7) === month;
      const all = byDay.get(key) ?? [];
      return {
        key,
        num: inMonth ? String(d.getUTCDate()) : `${t(`cal.short.${d.getUTCMonth() + 1}`)} ${d.getUTCDate()}`,
        inMonth,
        visible: all.slice(0, DAY_VISIBLE),
        rest: all.slice(DAY_VISIBLE),
      };
    }),
  );
}

export function googleState(t: T, p: GooglePost): { label: string; tone: "good" | "info" | "bad" | "neutral" } {
  switch ((p.state ?? "").toUpperCase()) {
    case "LIVE":
      return { label: t("ggl.state.published"), tone: "good" };
    case "PROCESSING":
      return { label: t("ggl.state.processing"), tone: "info" };
    case "REJECTED":
      return { label: t("ggl.state.rejected"), tone: "bad" };
    default:
      return { label: p.state ? enumLabel(p.state).toLowerCase() : t("ggl.state.unknown"), tone: "neutral" };
  }
}
export function googleNote(t: T, p: GooglePost): { text: string; tone: "muted" | "bad" } | null {
  const state = (p.state ?? "").toUpperCase();
  if (state === "REJECTED") {
    return { text: p.managedHere ? t("ggl.rejected") : t("ggl.rejectedOutside"), tone: "bad" };
  }
  if (state === "PROCESSING") return { text: t("ggl.processing"), tone: "muted" };
  if (!p.managedHere) return { text: t("ggl.outside"), tone: "muted" };
  return null;
}
export const googleHeadline = (t: T, n: number, location: string, truncated: boolean): string =>
  t(truncated ? "ggl.headlineTruncated" : "ggl.headline", { count: n, location });
