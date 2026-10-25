// Pure logic for Home ("Needs attention"). Only types come from core (erased at build).
import type { attentionQueue } from "@opengmb/core";
import { changeSummary } from "./alerts";
import { agentsHref } from "./agents";
import { approvalsHref } from "./approvals";
import { approvalSurfaces } from "./approval-surfaces";
import { failureLabel } from "./failure-labels";
import { COMFORTABLE_MAX_LOCATIONS } from "./preferences";

export type Queue = Awaited<ReturnType<typeof attentionQueue.handler>>;
export type AttentionItem = Queue["items"][number];
export type Counts = Queue["counts"];

/** Our own nudge, not a Google rule: suggest a post after this many days without one. */
export const POST_GAP_DAYS = 7;
const DAY_MS = 86_400_000;

/** Home's translator: `useTranslations("home")` in a component, `getTranslations("home")` on a page. */
export type T = (key: string, values?: Record<string, string | number>) => string;

/** The pill's label is t(`pill.${key}`). */
export const TYPE_PILLS = [
  { key: "all" }, { key: "approvals" }, { key: "reviews" }, { key: "changes" }, { key: "agent" }, { key: "failed" },
] as const;
export type TypeFilter = (typeof TYPE_PILLS)[number]["key"];
const KINDS: Record<Exclude<TypeFilter, "all">, AttentionItem["kind"][]> = {
  approvals: ["approval"],
  reviews: ["negative_review", "review"],
  changes: ["change"],
  agent: ["proposal"],
  failed: ["failed"],
};
/** Where "Showing N of M" sends you for the rest of one type. The link text is t(`seeAll.${type}`). */
export const SEE_ALL: Partial<Record<TypeFilter, { href: string }>> = {
  approvals: { href: "/approvals" },
  reviews: { href: "/reviews?replied=no" },
  changes: { href: "/locations/alerts" },
  agent: { href: "/agents?view=proposals" },
};

/** Home's own params. Scope (?ws=) is resolved by currentScope(), not here. */
export function parseHomeSearch(sp: { type?: string }): { type: TypeFilter } {
  return { type: TYPE_PILLS.some((p) => p.key === sp.type) ? (sp.type as TypeFilter) : "all" };
}

export function homeHref(o: { ws: string | null; type?: TypeFilter }): string {
  const p = new URLSearchParams();
  if (o.ws) p.set("ws", o.ws);
  if (o.type && o.type !== "all") p.set("type", o.type);
  const qs = p.toString();
  return qs ? `/?${qs}` : "/";
}

export function pillCount(c: Counts, t: TypeFilter): number {
  if (t === "all") return c.total;
  if (t === "approvals") return approvalSurfaces(c.approvals).home.total;
  if (t === "reviews") return c.reviews.total;
  if (t === "changes") return c.changes;
  if (t === "agent") return c.proposals;
  return c.failed.total;
}

export const inType = (items: AttentionItem[], t: TypeFilter) =>
  t === "all" ? items : items.filter((i) => KINDS[t].includes(i.kind));

export type HomeMode = "no_workspace" | "no_google" | "no_locations" | "owner" | "agency";
/** The one layout rule (spec: 1 to 3 active locations in scope = owner). 0C passes its scope's count. */
export const homeLayout = (activeLocations: number): "owner" | "agency" =>
  activeLocations <= COMFORTABLE_MAX_LOCATIONS ? "owner" : "agency";

/** `scopeActive` is the scope's active-location count (lib/scope.ts); it decides the layout. */
export function homeMode(q: Pick<Queue, "setup" | "activeLocations">, scopeActive: number = q.activeLocations): HomeMode {
  const s = q.setup;
  if (s.workspaces === 0) return "no_workspace";
  if (s.googleConnections === 0 && s.locations === 0) return "no_google";
  if (q.activeLocations === 0 || scopeActive === 0) return "no_locations";
  return homeLayout(scopeActive);
}

export type Step = { title: string; hint: string; done: boolean; href: string; cta: string };
/** First run, in the order a new account walks it. Every `done` is a fact read from the database. */
/** `hidden` lists step keys this build leaves out (see HIDDEN_SETUP_STEPS in nav-private). */
export function setupSteps(s: Queue["setup"], t: T, hidden: readonly string[] = []): Step[] {
  const step = (k: string) => ({ k, title: t(`step.${k}.title`), hint: t(`step.${k}.hint`), cta: t(`step.${k}.cta`) });
  return [
    { ...step("create"), done: s.workspaces > 0, href: "/workspaces" },
    { ...step("google"), done: s.googleConnections > 0, href: "/settings/google" },
    { ...step("import"), done: s.locations > 0, href: "/locations/import" },
    { ...step("health"), done: s.healthReportSeen, href: "/locations/health" },
    { ...step("team"), done: s.teamInvited, href: "/settings/team" },
    { ...step("timezone"), done: s.timeZoneSet, href: "/settings/workspace" },
  ]
    .filter((x) => !hidden.includes(x.k))
    .map(({ k: _k, ...rest }) => rest);
}
/** The checklist shows until every step is done or an owner or admin dismisses it. */
export const setupOpen = (s: Queue["setup"], steps: Step[]): boolean =>
  !s.setupDismissed && steps.some((x) => !x.done);
/** "4 of 6 done. Next: invite an approver or teammate." */
export function setupLine(steps: Step[], t: T): string {
  const next = steps.find((s) => !s.done);
  const done = steps.filter((s) => s.done).length;
  return next
    ? t("setupLine", { done, total: steps.length, next: next.title.toLowerCase() })
    : t("setupLineDone", { done, total: steps.length });
}

export type Tile = { type: TypeFilter; n: number; label: string; hint: string; tone: "brand" | "bad" | "plain" };
export function tiles(c: Counts, o: { writesOff: boolean }, t: T): Tile[] {
  const a = c.approvals;
  return [
    { type: "approvals", n: approvalSurfaces(a).home.total, label: t("tile.approvals.label"), hint: t("tile.approvals.hint", { reply: a.reply, post: a.post, changeset: a.changeset, postedit: a.postedit }), tone: "brand" },
    { type: "reviews", n: c.reviews.negative, label: t("tile.negative.label"), hint: t("tile.negative.hint", { max: c.negativeMaxStars }), tone: "bad" },
    { type: "reviews", n: c.reviews.other, label: t("tile.unreplied.label"), hint: t("tile.unreplied.hint"), tone: "plain" },
    { type: "changes", n: c.changes, label: t("tile.changes.label"), hint: t("tile.changes.hint"), tone: "plain" },
    { type: "agent", n: c.proposals, label: t("tile.proposals.label"), hint: t("tile.proposals.hint"), tone: "plain" },
    { type: "failed", n: c.failed.total, label: t("tile.failed.label"), hint: o.writesOff ? t("tile.failed.hintOff") : t("tile.failed.hint"), tone: "bad" },
  ];
}

export function itemTitle(i: AttentionItem): string {
  if (i.kind !== "change") return i.title;
  return `${changeSummary(i.fields)} ${i.googleSuggested ? "by Google" : "outside OpenGMB"}`;
}

export function itemWhere(i: AttentionItem, t: T): string {
  if (i.kind === "proposal") return t("where.token", { token: i.detail ?? t("where.unknown") });
  const locs = i.locationNames.length > 2 ? t("where.locations", { n: i.locationNames.length }) : i.locationNames.join(", ");
  return [i.workspaceName, locs].filter(Boolean).join(" · ");
}

export function itemLink(i: AttentionItem, ws: string | null, t: T): { href: string; label: string; primary: boolean } {
  if (i.subject === "review") return { href: `/reviews?review=${i.id}`, label: t("link.reply"), primary: true };
  if (i.subject === "change") return { href: `/locations/alerts?change=${i.id}`, label: t("link.compare"), primary: false };
  if (i.subject === "proposal") return { href: agentsHref({ view: "proposals", proposal: i.id }), label: t("link.review"), primary: true };
  if (i.kind === "approval") return { href: approvalsHref({ ws: ws ?? undefined, item: `${i.subject}:${i.id}` }), label: t("link.review"), primary: true };
  if (i.subject === "reply") return { href: `/reviews?review=${i.reviewId}`, label: t("link.open"), primary: false };
  if (i.subject === "post") return { href: `/posts?view=list&post=${i.id}`, label: t("link.open"), primary: false };
  return { href: "/locations/bulk-edit", label: t("link.open"), primary: false };
}

export type ChipTone = "agent" | "warn" | "bad" | "neutral";
export function itemChip(i: AttentionItem, now: number, t: T): { text: string; tone: ChipTone } {
  if (i.kind === "proposal") return { text: t("chip.proposal", { mins: Math.max(0, Math.ceil((Date.parse(i.expiresAt ?? "") - now) / 60_000)) }), tone: "agent" };
  if (i.kind === "change") return { text: i.googleSuggested ? t("chip.googleSuggested") : t("chip.nightly"), tone: "warn" };
  if (i.kind === "failed") {
    if (!i.code) return { text: t("chip.noReason"), tone: "bad" };
    const label = failureLabel(i.code);
    return { text: label === i.code ? i.code : `${i.code}: ${label}`, tone: "bad" };
  }
  if (i.subject === "review") {
    if (i.replyStatus === "draft") return { text: t("chip.draftSaved"), tone: "neutral" };
    if (i.replyStatus === "blocked") return { text: t("chip.draftBlocked"), tone: "warn" };
    return { text: t("chip.noDraft"), tone: "neutral" };
  }
  if (i.provenance.createdSurface === "mcp") return { text: t("chip.claudeMcp"), tone: "agent" };
  return { text: i.provenance.createdByName ? t("chip.draftedBy", { name: i.provenance.createdByName }) : t("chip.draftedHere"), tone: "neutral" };
}

export type NextAction = { title: string; text: string; cta?: string; href: string; tone: "bad" | "brand" | "warn" };
export function nextActions(c: Counts, cards: Pick<Queue["locations"][number], "lastPostAt">[], now: number, t: T): NextAction[] {
  const out: NextAction[] = [];
  const r = c.reviews;
  if (r.total > 0) {
    out.push({
      title: t("next.reviewsTitle", { n: r.total }),
      text: r.negative > 0 ? t("next.reviewsTextNegative", { negative: r.negative, max: c.negativeMaxStars }) : t("next.reviewsText"),
      cta: t("next.reviewsCta"), href: "/reviews?replied=no", tone: "bad",
    });
  }
  const a = approvalSurfaces(c.approvals).home.total;
  if (a > 0) {
    out.push({
      title: t("next.approvalsTitle", { n: a }),
      text: t("next.approvalsText"),
      cta: t("next.approvalsCta"), href: "/approvals", tone: "brand",
    });
  }
  if (c.changes > 0) {
    out.push({
      title: t("next.changesTitle", { n: c.changes }),
      text: t("next.changesText"),
      cta: t("next.changesCta"), href: "/locations/alerts", tone: "warn",
    });
  }
  const last = cards.map((l) => l.lastPostAt).filter((x): x is string => x !== null).sort().at(-1);
  const days = last ? Math.floor((now - Date.parse(last)) / DAY_MS) : null;
  if (days === null || days >= POST_GAP_DAYS) {
    out.push({
      title: days === null ? t("next.noPosts") : t("next.postGap", { days }),
      text: t("next.postText"),
      // No button: the header's "New post" is the one write-a-post control on Home.
      href: "/posts", tone: "brand",
    });
  }
  return out.slice(0, 3);
}

export const syncedText = (iso: string | null, age: string, t: T) => (iso ? t("synced", { age }) : t("syncedNever"));

// Home's own copies of five shared English helpers (ageLabel, autoApproveChipText, daysAgoText,
// deltaText, waitingToPublishText), so Home translates without touching files other pages use.
/** `5 m`, `2 h`, `3 d`; "" for null. `now` is passed in so a server render and its hydration agree. */
export function ageText(iso: string | null, now: number, t: T): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (mins < 60) return t("age.minutes", { n: mins });
  const hours = Math.floor(mins / 60);
  return hours < 24 ? t("age.hours", { n: hours }) : t("age.days", { n: Math.floor(hours / 24) });
}

/** "Auto-approve 4★ and up is on in 2 clients"; null when no client has it on. */
export function autoApproveText(minStars: (4 | 5 | null)[], t: T): string | null {
  const on = minStars.filter((s): s is 4 | 5 => s !== null);
  if (on.length === 0) return null;
  const rule = new Set(on).size > 1 ? t("autoApprove.both") : on[0] === 4 ? t("autoApprove.four") : t("autoApprove.five");
  return t("autoApprove.chip", { rule, n: on.length });
}

export function daysAgoLabel(iso: string, now: Date, t: T): string {
  const d = Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS);
  return d <= 0 ? t("daysAgo.today") : d === 1 ? t("daysAgo.one") : t("daysAgo.other", { n: d });
}

export function deltaLabel(pct: number | null, t: T): { text: string; dir: "up" | "down" | "flat" } | null {
  if (pct === null) return null;
  const r = Math.round(pct * 100);
  if (r === 0) return { text: t("owner.none"), dir: "flat" };
  return r > 0 ? { text: t("owner.up", { pct: r }), dir: "up" } : { text: t("owner.down", { pct: -r }), dir: "down" };
}

/** "2 approved replies are waiting to publish." plus, when writes are off, why nothing is sent. */
export const waitingText = (n: number, writesOff: boolean, t: T): string =>
  `${t("state.waiting", { n })}${writesOff ? ` ${t("state.waitingOff")}` : ""}`;
