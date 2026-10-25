import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import { PAGES } from "../messages/pages";
import { approvalSurfaces, queueRedirect } from "./approval-surfaces";
import { nextActions, pillCount, tiles, type Counts as HomeCounts, type T } from "./home";
import { navFor } from "./nav";

const t = createTranslator({ locale: "en", messages: { home: PAGES.home.en }, namespace: "home" }) as unknown as T;

const counts = { reply: 4, post: 2, changeset: 3, postedit: 5, total: 14 };

describe("approvalSurfaces: every badge and count from one counts object", () => {
  it("gives the nav badge, Home, the /approvals tabs and the Reviews and Posts tabs the same numbers", () => {
    const s = approvalSurfaces(counts);
    expect(s.nav).toBe(14);
    expect(s.home.total).toBe(14);
    expect(s.tabs).toEqual({ all: 14, reply: 4, post: 2, changeset: 3, postedit: 5 });
    // The Reviews and Posts tabs show the /approvals tab number of the same type.
    expect(s.reviewsTab).toEqual({ href: "/approvals?tab=reply", label: "Approval queue (4)" });
    expect(s.postsTab).toEqual({ href: "/approvals?tab=post", label: "Approval queue (2)" });
    // The three tab numbers add up to the badge: nothing is counted twice or dropped.
    expect(s.tabs.reply + s.tabs.post + s.tabs.changeset + s.tabs.postedit).toBe(s.nav);
  });

  it("the real nav badge, Home tile, Home pill and Home alert show that same number", () => {
    const s = approvalSurfaces(counts);
    const home = {
      approvals: counts,
      reviews: { negative: 0, other: 0, total: 0 },
      waitingToPublish: 0, changes: 0, proposals: 0,
      failed: { reply: 0, post: 0, changeset: 0, total: 0 },
      total: counts.total, negativeMaxStars: 3,
    } as HomeCounts;
    const nav = navFor(() => true, { "/approvals": s.nav }).flatMap((g) => g.items).find((i) => i.href === "/approvals");
    expect(nav?.badge).toBe(14);
    expect(tiles(home, { writesOff: false }, t)[0]!.n).toBe(14);
    expect(pillCount(home, "approvals")).toBe(14);
    expect(nextActions(home, [], Date.now(), t).some((a) => a.title === "14 items wait for your approval")).toBe(true);
  });

  it("a pending post edit is counted in the badge, Home and its own tab, and nowhere twice", () => {
    const s = approvalSurfaces({ reply: 0, post: 0, changeset: 0, postedit: 1, total: 1 });
    expect(s.nav).toBe(1);
    expect(s.home.total).toBe(1);
    expect(s.tabs).toEqual({ all: 1, reply: 0, post: 0, changeset: 0, postedit: 1 });
  });

  it("carries the client into the tab links and drops the number at zero", () => {
    const s = approvalSurfaces({ reply: 0, post: 0, changeset: 0, postedit: 0, total: 0 }, "ws1");
    expect(s.reviewsTab).toEqual({ href: "/approvals?tab=reply&ws=ws1", label: "Approval queue" });
    expect(s.postsTab).toEqual({ href: "/approvals?tab=post&ws=ws1", label: "Approval queue" });
  });
});

describe("queueRedirect: the old queue URLs land on /approvals with the filter applied", () => {
  it("sends the Reviews queue to the Replies tab and keeps ws", () => {
    expect(queueRedirect("reviews", {})).toBe("/approvals?tab=reply");
    expect(queueRedirect("reviews", { ws: "w1", qstatus: "pending_approval" })).toBe("/approvals?tab=reply&ws=w1");
  });
  it("sends the Posts queue to the Posts tab and keeps ws", () => {
    expect(queueRedirect("posts", {})).toBe("/approvals?tab=post");
    expect(queueRedirect("posts", { ws: "w1" })).toBe("/approvals?tab=post&ws=w1");
  });
  it("leaves a Reviews queue status that is not an approval where it is", () => {
    expect(queueRedirect("reviews", { qstatus: "approved" })).toBeNull();
    expect(queueRedirect("reviews", { qstatus: "blocked", ws: "w1" })).toBeNull();
  });
});
