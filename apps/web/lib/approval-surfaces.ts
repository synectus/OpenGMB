// The one place the approvals number turns into badges and tab labels. Core makes the counts
// (approvals.counts, the same numbers in attention.counts and approvals.queue); every surface reads
// them through here, so the nav badge, Home, the /approvals tabs and the Reviews and Posts tabs agree.
// Client-safe: no core value imports.
import { approvalsHref, type Counts, type Tab } from "./approvals";

const QUEUE = "Approval queue";
const label = (n: number) => (n > 0 ? `${QUEUE} (${n})` : QUEUE);

export function approvalSurfaces(counts: Counts, ws?: string) {
  return {
    /** The Approvals badge in the nav. */
    nav: counts.total,
    /** Home's "Waiting for approval" tile and its alert. */
    home: { total: counts.total },
    /** /approvals: All, Replies, Posts, Profile changes, Post edits. */
    tabs: { all: counts.total, reply: counts.reply, post: counts.post, changeset: counts.changeset, postedit: counts.postedit } satisfies Record<Tab, number>,
    /** The Reviews and Posts tabs: links into /approvals with that type preselected. */
    reviewsTab: { href: approvalsHref({ tab: "reply", ws }), label: label(counts.reply) },
    postsTab: { href: approvalsHref({ tab: "post", ws }), label: label(counts.post) },
  };
}

/**
 * Where an old queue URL goes: /approvals with the matching type. Null when it is not an approval
 * (a Reviews queue status other than pending_approval stays on /reviews).
 */
export function queueRedirect(from: "reviews" | "posts", sp: { ws?: string; qstatus?: string }): string | null {
  if (from === "reviews" && sp.qstatus && sp.qstatus !== "pending_approval") return null;
  return approvalsHref({ tab: from === "reviews" ? "reply" : "post", ws: sp.ws });
}
