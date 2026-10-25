// Pure model of the /reviews tabs. No React, no core value imports.

export type ReviewsView = "inbox" | "bulk" | "analytics" | "requests" | "queue";

const VIEWS: { key: ReviewsView; label: string; href: string }[] = [
  { key: "inbox", label: "Inbox", href: "/reviews" },
  { key: "bulk", label: "Bulk reply", href: "/reviews?view=bulk" },
  { key: "analytics", label: "Analytics", href: "/reviews?view=analytics" },
  { key: "requests", label: "Requests", href: "/reviews?view=requests" },
  { key: "queue", label: "Approval queue", href: "/reviews?view=queue" },
];

/** Views whose page exists: a tab never 404s. */
export const SHIPPED_VIEWS: ReadonlySet<ReviewsView> = new Set<ReviewsView>(["inbox", "bulk", "analytics", "requests", "queue"]);

/** The requested view if it is shipped and the role may open it, else the inbox. The queue tab is gated by the page's own probe. */
export function parseView(raw: string | undefined, o: { canDraft: boolean }): ReviewsView {
  const v = VIEWS.find((x) => x.key === raw)?.key;
  if (!v || !SHIPPED_VIEWS.has(v)) return "inbox";
  if (v === "bulk" && !o.canDraft) return "inbox";
  return v;
}

export function reviewsTabs(
  current: ReviewsView,
  o: { hasQueue: boolean; canDraft: boolean; ws?: string; queueTab?: { href: string; label: string } },
): { key: ReviewsView; href: string; label: string; current: boolean }[] {
  return VIEWS.filter(
    (v) =>
      SHIPPED_VIEWS.has(v.key) &&
      (v.key !== "queue" || o.hasQueue) &&
      (v.key !== "bulk" || o.canDraft),
  ).map((v) => ({
    key: v.key,
    // The queue tab is a link into /approvals (Replies preselected); its label carries the one approvals count.
    href: v.key === "queue" && o.queueTab ? o.queueTab.href : (v.key === "bulk" || v.key === "analytics" || v.key === "requests") && o.ws ? `${v.href}&ws=${encodeURIComponent(o.ws)}` : v.href,
    label: v.key === "queue" && o.queueTab ? o.queueTab.label : v.label,
    current: v.key === current,
  }));
}
