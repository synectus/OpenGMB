import type { PostLanguage } from "@opengmb/core";
import { utcToWall, zonedWallToUtc } from "@opengmb/core/time";
import { ctaName, statusText, type T } from "./posts-lists";

// ---- views ---------------------------------------------------------------------------------

/**
 * Views of /posts. The four tabs are All posts, Calendar, On Google and Library; Compose is the
 * "New post" page and has no tab; Import (bulk drafts from a file) is likewise reached by a button. Old ?view= values are mapped by `legacyPostView`.
 */
export type PostView = "compose" | "import" | "list" | "calendar" | "google" | "library";
export type LibrarySection = "media" | "templates";

const TABS: { key: PostView }[] = [{ key: "list" }, { key: "calendar" }, { key: "google" }, { key: "library" }];

export function parsePostView(v: string | undefined): PostView {
  return v === "compose" || v === "import" || TABS.some((t) => t.key === v) ? (v as PostView) : "list";
}

export const parseLibrarySection = (v: string | undefined): LibrarySection => (v === "templates" ? "templates" : "media");

/** Where an old tab URL now lives: the Media library and Templates tabs became the Library tab's two sections. */
export function legacyPostView(v: string | undefined): { view: PostView; section: LibrarySection } | null {
  if (v === "media") return { view: "library", section: "media" };
  if (v === "templates") return { view: "library", section: "templates" };
  return null;
}

/** All posts is plain /posts; ws may be a workspace id or "all" (All posts only). */
export function postsHref(view: PostView, ws?: string, section?: LibrarySection): string {
  const p = new URLSearchParams();
  if (view !== "list") p.set("view", view);
  if (view === "library" && section === "templates") p.set("section", section);
  if (ws) p.set("ws", ws);
  const qs = p.toString();
  return qs ? `/posts?${qs}` : "/posts";
}

export function postViewTabs(
  t: T,
  current: PostView,
  o: { ws?: string },
): { key: PostView; href: string; label: string; current: boolean }[] {
  return TABS.map((v) => ({ key: v.key, href: postsHref(v.key, o.ws), label: t(`tabs.${v.key}`), current: v.key === current }));
}

// ---- the form ------------------------------------------------------------------------------

/** The four post types; each one's name is `type.<key>` in the posts messages. */
export const POST_TYPES = [{ key: "STANDARD" }, { key: "EVENT" }, { key: "OFFER" }, { key: "ALERT" }] as const;
export type TopicType = (typeof POST_TYPES)[number]["key"];

/** Button names (`cta.<value>` in the posts messages); the values must equal POST_LIMITS.ctaActionTypes (a test checks). */
const CTA_VALUES = ["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"];
export const CTA_OPTIONS: { value: string }[] = [{ value: "none" }, ...CTA_VALUES.map((value) => ({ value }))];
export const ctaOptionLabel = (t: T, value: string): string => (value === "none" ? t("cta.none") : ctaName(t, value));

/** The image slot's value. Plan 2C adds a media-library id next to the URL. */
export type PostImage = { sourceUrl: string };

export type ComposeForm = {
  topicType: TopicType;
  language: PostLanguage;
  summary: string;
  ctaType: string;
  ctaUrl: string;
  title: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  couponCode: string;
  redeemOnlineUrl: string;
  termsConditions: string;
  image: PostImage | null;
  /** The send time picked in Compose: a datetime-local value ("2026-10-19T09:00") in the client's zone, or "" for none. */
  sendAt: string;
};

/** The fields of a saved post (posts.get) the form reads. */
export type PostSeed = {
  topicType: TopicType;
  language: PostLanguage;
  summary: string;
  cta: { actionType: string; url?: string | null } | null;
  event: {
    title?: string | null;
    startDate?: string | null;
    startTime?: string | null;
    endDate?: string | null;
    endTime?: string | null;
  } | null;
  offer: {
    couponCode?: string | null;
    redeemOnlineUrl?: string | null;
    termsConditions?: string | null;
  } | null;
  media: { sourceUrl: string }[];
  /** The send time saved with the draft (an instant), if any. */
  scheduledFor?: string | null;
};

export function initialForm(
  p: PostSeed | undefined,
  defaultLanguage: PostLanguage,
  zone?: string,
): ComposeForm {
  return {
    topicType: p?.topicType ?? "STANDARD",
    language: p?.language ?? defaultLanguage,
    summary: p?.summary ?? "",
    ctaType: p?.cta?.actionType ?? "none",
    ctaUrl: p?.cta?.url ?? "",
    title: p?.event?.title ?? "",
    startDate: p?.event?.startDate ?? "",
    startTime: p?.event?.startTime ?? "",
    endDate: p?.event?.endDate ?? "",
    endTime: p?.event?.endTime ?? "",
    couponCode: p?.offer?.couponCode ?? "",
    redeemOnlineUrl: p?.offer?.redeemOnlineUrl ?? "",
    termsConditions: p?.offer?.termsConditions ?? "",
    image: p?.media[0] ? { sourceUrl: p.media[0].sourceUrl } : null,
    sendAt: p?.scheduledFor && zone ? utcToWall(p.scheduledFor, zone) : "",
  };
}

/** A picked time may be this late (clock skew, the minute it takes to click) and still count as now. Matches posts.createDraft. */
export const SEND_TIME_GRACE_MS = 60_000;

/** The instant (ISO) of a picked wall time in the client's zone; null for nothing picked or an invalid value. */
export function sendTimeInstant(sendAt: string, zone: string): string | null {
  const at = sendAt ? zonedWallToUtc(sendAt, zone) : null;
  return at ? at.toISOString() : null;
}

/** Why the picked time cannot be saved, or null when it is empty or fine. */
export function sendTimeProblem(t: T, sendAt: string, zone: string, now: number = Date.now()): string | null {
  if (!sendAt) return null;
  const at = zonedWallToUtc(sendAt, zone);
  if (!at) return t("lib.sendTimePick");
  if (at.getTime() < now - SEND_TIME_GRACE_MS) return t("lib.sendTimePassed");
  return null;
}

const opt = (v: string) => (v.trim() ? v.trim() : undefined);
const clean = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * Content in the shape posts.check / createDraft / updateDraft take (language is sent beside it).
 * Fields the chosen type hides are never sent: an Alert takes only a summary and a call to action.
 */
export function toContent(f: ComposeForm) {
  const t = f.topicType;
  const dated = t === "EVENT" || t === "OFFER";
  const image = t !== "ALERT" && f.image ? opt(f.image.sourceUrl) : undefined;
  return {
    topicType: t,
    alertType: t === "ALERT" ? "COVID_19" : null,
    summary: f.summary,
    cta:
      f.ctaType === "none"
        ? null
        : clean({
            actionType: f.ctaType,
            url: f.ctaType === "CALL" ? undefined : opt(f.ctaUrl),
          }),
    event: dated
      ? clean({
          title: f.title,
          startDate: f.startDate,
          startTime: opt(f.startTime),
          endDate: f.endDate,
          endTime: opt(f.endTime),
        })
      : null,
    offer:
      t === "OFFER"
        ? clean({
            couponCode: opt(f.couponCode),
            redeemOnlineUrl: opt(f.redeemOnlineUrl),
            termsConditions: opt(f.termsConditions),
          })
        : null,
    media: image ? [{ sourceUrl: image }] : [],
  };
}

export function ctaHint(t: T, ctaType: string): string {
  return ctaType === "CALL" ? t("lib.ctaHintCall") : t("lib.ctaHintOther");
}

export function languageGroups<L extends { code: string }>(langs: readonly L[]) {
  return { main: langs.slice(0, 2), other: langs.slice(2) };
}

// ---- Check ---------------------------------------------------------------------------------

export function counter(summary: string, max: number): { text: string; over: boolean } {
  const n = Array.from(summary).length;
  return { text: `${n} / ${max}`, over: n > max };
}

export function checkBadge(t: T, r: {
  violations: { severity: "block" | "warn" }[];
}): { tone: "bad" | "warn"; text: string } | null {
  const blocks = r.violations.filter((v) => v.severity === "block").length;
  if (blocks) return { tone: "bad", text: t("lib.blocksPublishing", { count: blocks }) };
  const n = r.violations.length;
  return n ? { tone: "warn", text: t("lib.warnings", { count: n }) } : null;
}

const PACKS = ["post", "universal", "hipaa", "legal_ethics"];
export const packLabel = (t: T, id: string) => (PACKS.includes(id) ? t(`lib.pack.${id}`) : id);

const joinAnd = (t: T, xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : t("lib.joinAnd", { list: xs.slice(0, -1).join(", "), last: xs.at(-1)! });

export function packsLine(t: T, packs: string[], workspaceName: string): string {
  const rank = (id: string) => {
    const i = PACKS.indexOf(id);
    return i === -1 ? PACKS.length : i;
  };
  const names = [...packs].sort((a, b) => rank(a) - rank(b)).map((id) => packLabel(t, id));
  return t("lib.packsLine", { names: joinAnd(t, names), name: workspaceName });
}

// ---- states --------------------------------------------------------------------------------

/** The tone of each note under the Compose form; its text is `note.<key>` in the posts messages. */
export const NOTES = {
  saved: { tone: "good" },
  blocked: { tone: "bad" },
  ack: { tone: "warn" },
  submitted: { tone: "info" },
} as const;
export type NoteKey = keyof typeof NOTES;

export const editingLine = (t: T, status: string) => t("lib.editingLine", { status: statusText(t, status) });
export const sentBackLine = (t: T, name: string | null, reason: string) =>
  t("lib.sentBackLine", { name: name ?? t("lib.anApprover"), reason });
export const selectedText = (t: T, n: number, total: number) => t("lib.selected", { n, total });

// ---- preview -------------------------------------------------------------------------------

export function previewPlace(t: T, titles: string[]): string {
  if (titles.length === 0) return t("lib.noLocationPicked");
  return titles.length === 1 ? titles[0]! : t("lib.andMore", { first: titles[0]!, count: titles.length - 1 });
}

/** The button Google would show; none on offers (Google ignores it there). */
export function previewCta(t: T, f: ComposeForm): string | null {
  if (f.ctaType === "none" || f.topicType === "OFFER") return null;
  return CTA_VALUES.includes(f.ctaType) ? ctaName(t, f.ctaType) : null;
}

export function previewWhen(t: T, f: ComposeForm): string | null {
  if ((f.topicType !== "EVENT" && f.topicType !== "OFFER") || !f.startDate) return null;
  const at = (d: string, time: string) => (time ? `${d} ${time}` : d);
  return t("lib.whenRange", { start: at(f.startDate, f.startTime), end: at(f.endDate, f.endTime) });
}
