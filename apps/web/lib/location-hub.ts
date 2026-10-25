// Pure logic for one location's header, tabs and Overview. Client-safe.
import { dayKey } from "@opengmb/core/time";
import { approvalsHref } from "./approvals";

const DAY_MS = 86_400_000;

export type HubFacts = {
  locationId: string;
  stats: { reviews: { unreplied: number }; openChanges: number };
  changeSets: {
    id: string;
    status: string;
    fieldNames: string[];
    locationCount: number;
    createdByName: string | null;
    createdSurface: string;
  }[];
  /** null when photos could not be read (or Google was not read): no photo row then. */
  photos: { newestDays: number | null } | null;
};
/** `msg` is the same line as `text` as a message key (under locationHub.hub.attn) plus its values, for translated rendering. */
export type Attention = {
  key: string;
  text: string;
  msg: { key: string; values: Record<string, string | number> };
  href: string;
  link: string;
  surface?: string;
};

export const changeSetLine = (c: { fieldNames: string[]; locationCount: number }) =>
  `${c.fieldNames.join(", ")} on ${c.locationCount} ${c.locationCount === 1 ? "location" : "locations"}`;

export function attentionItems(o: HubFacts, cfg: { snapshotUtc: string; recentPhotoDays: number }): Attention[] {
  const id = o.locationId;
  const out: Attention[] = [];
  const u = o.stats.reviews.unreplied;
  if (u > 0)
    out.push({
      key: "reviews",
      text: `${u} ${u === 1 ? "review needs" : "reviews need"} a reply`,
      msg: { key: "reviews", values: { count: u } },
      href: `/reviews?replied=no&loc=${id}`,
      link: "Reviews",
    });
  const c = o.stats.openChanges;
  if (c > 0)
    out.push({
      key: "changes",
      text: `${c} profile ${c === 1 ? "change" : "changes"} found by the nightly snapshot (${cfg.snapshotUtc} UTC)`,
      msg: { key: "changes", values: { count: c, time: cfg.snapshotUtc } },
      href: `/locations/${id}/changes`,
      link: "Changes",
    });
  for (const s of o.changeSets.filter((x) => x.status === "pending_approval")) {
    out.push({
      key: `cs-${s.id}`,
      text: `Change set pending approval: ${changeSetLine(s)}${s.createdByName ? `, proposed by ${s.createdByName}` : ""}`,
      msg: {
        key: s.createdByName ? "changeSetBy" : "changeSet",
        values: { fields: s.fieldNames.join(", "), count: s.locationCount, name: s.createdByName ?? "" },
      },
      href: approvalsHref({ tab: "changeset", item: `changeset:${s.id}` }),
      link: "Approvals",
      surface: s.createdSurface,
    });
  }
  if (o.photos) {
    const d = o.photos.newestDays;
    if (d === null)
      out.push({ key: "photos", text: "No photos yet", msg: { key: "noPhotos", values: {} }, href: `/locations/${id}/media`, link: "Photos" });
    else if (d > cfg.recentPhotoDays)
      out.push({
        key: "photos",
        text: `Newest photo is ${d} days old`,
        msg: { key: "oldPhoto", values: { days: d } },
        href: `/locations/${id}/media`,
        link: "Photos",
      });
  }
  return out;
}

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
/** The last 28 complete days in the client's zone: yesterday and the 27 days before it. */
export function last28Days(now: Date, timeZone: string): { from: string; to: string } {
  const end = Date.parse(`${dayKey(now, timeZone)}T00:00:00Z`) - DAY_MS;
  return { from: isoDay(end - 27 * DAY_MS), to: isoDay(end) };
}

/** Whole days from `iso` to `now` (0 or less = today). */
export const daysSince = (iso: string, now: Date): number => Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS);

export function daysAgoText(iso: string, now: Date): string {
  const d = daysSince(iso, now);
  return d <= 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`;
}

/** "30 3 * * *" -> "03:30" (minute and hour fields of a daily cron). */
export function cronTimeUtc(cron: string): string {
  const [m = "0", h = "0"] = cron.split(" ");
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

/** performance.summary's deltaPct is a fraction (0.12 = +12%), null when the earlier period was 0. */
export function deltaText(pct: number | null): string {
  if (pct === null) return "–";
  const r = Math.round(pct * 100);
  return `${r > 0 ? "+" : ""}${r}%`;
}

// Same labels as components/verification-panel.tsx.
const STANDING: Record<string, string> = {
  good_standing: "In good standing",
  wait_for_review: "Under review by Google",
  verify: "Verification needed",
  comply_with_guidelines: "Must comply with guidelines",
  resolve_ownership_conflict: "Ownership conflict",
};
export const standingLabel = (s: string) => STANDING[s] ?? "Unknown";

export function bookingTypeLabel(t: string): string {
  const words = t.toLowerCase().split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function locationTabs(
  id: string,
  pathname: string,
  openChanges: number,
): { key: string; href: string; label: string; current: boolean }[] {
  const base = `/locations/${id}`;
  const tabs = [
    { key: "overview", href: base, label: "Overview" },
    { key: "profile", href: `${base}/profile`, label: "Profile" },
    { key: "photos", href: `${base}/media`, label: "Photos" },
    { key: "health", href: `${base}/health`, label: "Health" },
    { key: "changes", href: `${base}/changes`, label: openChanges > 0 ? `Changes (${openChanges})` : "Changes" },
    { key: "suspension", href: `${base}/suspension`, label: "Suspension" },
    { key: "citations", href: `${base}/citations`, label: "Citations" },
  ];
  return tabs.map((t) => ({
    ...t,
    current: t.href === base ? pathname === base : pathname === t.href || pathname.startsWith(`${t.href}/`),
  }));
}
