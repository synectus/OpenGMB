// Pure /settings/notifications logic. Client-safe.

export const PAGE = 10;
/** notifications.list accepts limit 1 to 100 and has no cursor. */
export const MAX_SHOWN = 100;

const LINK_LABEL: Record<string, string> = {
  "google.new_review": "Open review",
  "google.updated_review": "Open review",
  "review.negative": "Open review",
  "review.assigned": "Open review",
  "approval.requested": "Open approval",
  "profile.changed": "See changes",
  "google.google_update": "See changes",
  "media.customer_photo": "View photo",
  "geogrid.budget_exceeded": "See usage",
};

/** The action link's text, or null when the notification has no link (Google notifications). */
export function linkLabel(kind: string, link: string | null): string | null {
  return link ? (LINK_LABEL[kind] ?? "Open") : null;
}

/**
 * What SynGMB does with each kind today. In app: always. Email: only approval requests, to the
 * workspace's client approvers (packages/core/src/approvals.ts). Daily digest: every unread
 * notification of the last 24 hours (apps/worker/src/digest.ts). Choosing is not live.
 */
export const PREFERENCE_ROWS: { kind: string; label: string; inApp: boolean; email: boolean; digest: boolean }[] = [
  { kind: "google.new_review", label: "New review", inApp: true, email: false, digest: true },
  { kind: "review.negative", label: "Negative review (1-3★)", inApp: true, email: false, digest: true },
  { kind: "review.assigned", label: "Review assigned to you", inApp: true, email: false, digest: true },
  { kind: "google.updated_review", label: "Updated review", inApp: true, email: false, digest: true },
  { kind: "approval.requested", label: "Approval requested (client approvers)", inApp: true, email: true, digest: true },
  { kind: "profile.changed", label: "Profile changed outside OpenGMB", inApp: true, email: false, digest: true },
  { kind: "google.google_update", label: "Google suggested edit", inApp: true, email: false, digest: true },
  { kind: "media.customer_photo", label: "Customer photo", inApp: true, email: false, digest: true },
  { kind: "geogrid.budget_exceeded", label: "Rank tracking budget reached", inApp: true, email: false, digest: true },
];

export function parseShow(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= PAGE) return PAGE;
  return Math.min(MAX_SHOWN, Math.ceil(n / PAGE) * PAGE);
}

export function notificationsHref(o: { unread: boolean; show: number }): string {
  const p = new URLSearchParams();
  if (o.unread) p.set("filter", "unread");
  if (o.show > PAGE) p.set("show", String(o.show));
  const q = p.toString();
  return `/settings/notifications${q ? `?${q}` : ""}`;
}

export function listFooter(count: number, show: number, unread: boolean): { caption: string; olderHref: string | null } {
  if (count === 0) return { caption: "", olderHref: null };
  if (count < show) return { caption: `Showing all ${count}`, olderHref: null };
  if (show >= MAX_SHOWN) {
    return {
      caption: `Showing the ${MAX_SHOWN} newest. Older notifications are kept but not listed here.`,
      olderHref: null,
    };
  }
  return { caption: `Showing the ${show} newest`, olderHref: notificationsHref({ unread, show: show + PAGE }) };
}
