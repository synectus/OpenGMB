import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import { PAGES } from "../messages/pages";
import { HOME_OWNER_MAX_LOCATIONS } from "@opengmb/core";
import { COMFORTABLE_MAX_LOCATIONS } from "./preferences";
import {
  homeHref, homeMode, inType, itemChip, itemLink, itemTitle, nextActions, parseHomeSearch, pillCount,
  setupLine, setupOpen, setupSteps, tiles, type AttentionItem, type Counts, type Queue, type T,
} from "./home";

/** Home's English translator, so these tests read the same words people read. */
const t = createTranslator({ locale: "en", messages: { home: PAGES.home.en }, namespace: "home" }) as unknown as T;

const zero: Counts = {
  approvals: { reply: 0, post: 0, changeset: 0, postedit: 0, total: 0 },
  reviews: { negative: 0, other: 0, total: 0 },
  waitingToPublish: 0, changes: 0, proposals: 0, failed: { reply: 0, post: 0, changeset: 0, total: 0 }, total: 0, negativeMaxStars: 3,
};
const setup: Queue["setup"] = {
  workspaces: 1, googleConnections: 1, locations: 2, activeLocations: 2, hasReviews: true, hasPerformance: false,
  healthReportSeen: false, setupDismissed: false, teamInvited: false, timeZoneSet: false,
};
const item = (o: Partial<AttentionItem>): AttentionItem => ({
  kind: "review", subject: "review", id: "i1", reviewId: null, locationId: null, workspaceId: "w", workspaceName: "Northside Chiro",
  locationNames: ["Katy"], at: "2026-10-19T06:00:00.000Z", title: "t", detail: null, code: null, rating: null,
  replyStatus: null, fields: [], googleSuggested: false, provenance: { createdSurface: null, createdByName: null },
  expiresAt: null, ...o,
});
const NOW = Date.parse("2026-10-19T09:00:00.000Z");

describe("home", () => {
  it("one threshold: core's card limit equals the density default and the layout rule", () => {
    expect(HOME_OWNER_MAX_LOCATIONS).toBe(COMFORTABLE_MAX_LOCATIONS);
  });

  it("parses scope and type, and builds links back", () => {
    const ws = "0b8f1f3e-1d2c-4b5a-9e8f-123456789abc";
    expect(parseHomeSearch({ type: "failed" })).toEqual({ type: "failed" });
    expect(parseHomeSearch({ type: "bogus" })).toEqual({ type: "all" });
    expect(homeHref({ ws: "all" })).toBe("/?ws=all");
    expect(homeHref({ ws, type: "reviews" })).toBe(`/?ws=${ws}&type=reviews`);
    expect(homeHref({ ws: null, type: "all" })).toBe("/");
  });

  it("picks the mode from the setup facts", () => {
    expect(homeMode({ setup: { ...setup, workspaces: 0 }, activeLocations: 0 })).toBe("no_workspace");
    expect(homeMode({ setup: { ...setup, googleConnections: 0, locations: 0, activeLocations: 0 }, activeLocations: 0 })).toBe("no_google");
    expect(homeMode({ setup, activeLocations: 0 })).toBe("no_locations");
    expect(homeMode({ setup, activeLocations: 3 })).toBe("owner");
    expect(homeMode({ setup, activeLocations: 4 })).toBe("agency");
  });

  it("the scope's active-location count decides the layout, not the workspace's", () => {
    expect(homeMode({ setup, activeLocations: 20 }, 2)).toBe("owner");
    expect(homeMode({ setup, activeLocations: 2 }, 8)).toBe("agency");
    expect(homeMode({ setup, activeLocations: 5 }, 0)).toBe("no_locations");
  });

  it("setup steps: a build can hide a step (the community edition has no team page), and the rest still count", () => {
    const steps = setupSteps(setup, t, ["team"]);
    expect(steps.map((s) => s.title)).not.toContain("Invite an approver or teammate");
    expect(steps.some((s) => s.href === "/settings/team")).toBe(false);
    expect(steps).toHaveLength(5);
    const all = setupSteps({ ...setup, healthReportSeen: true, timeZoneSet: true }, t, ["team"]);
    expect(all.every((s) => s.done)).toBe(true);
    expect(setupLine(all, t)).toContain("5 of 5");
  });

  it("setup steps: 6, in order, each done from its own fact", () => {
    const steps = setupSteps(setup, t);
    expect(steps.map((s) => [s.title, s.done])).toEqual([
      ["Create a client", true], ["Connect Google", true], ["Import locations", true],
      ["See your first health report", false], ["Invite an approver or teammate", false], ["Set the client time zone", false],
    ]);
    const all = setupSteps({ ...setup, healthReportSeen: true, teamInvited: true, timeZoneSet: true }, t);
    expect(all.every((s) => s.done)).toBe(true);
    expect(setupSteps({ ...setup, locations: 0 }, t).find((s) => s.title === "Import locations")!.done).toBe(false);
    expect(steps.every((s) => s.href.startsWith("/") && s.cta.length > 0)).toBe(true);
  });

  it("the checklist hides when complete or dismissed, shows otherwise", () => {
    const steps = setupSteps(setup, t);
    const done = setupSteps({ ...setup, healthReportSeen: true, teamInvited: true, timeZoneSet: true }, t);
    expect(setupOpen(setup, steps)).toBe(true);
    expect(setupOpen({ ...setup, setupDismissed: true }, steps)).toBe(false);
    expect(setupOpen({ ...setup, healthReportSeen: true, teamInvited: true, timeZoneSet: true }, done)).toBe(false);
  });

  it("pills count from the buckets and filter by kind", () => {
    const c = { ...zero, reviews: { negative: 3, other: 23, total: 26 }, total: 26 };
    expect(pillCount(c, "reviews")).toBe(26);
    expect(pillCount(c, "all")).toBe(26);
    const list = [item({ kind: "negative_review" }), item({ kind: "approval", subject: "reply" }), item({ kind: "review" })];
    expect(inType(list, "reviews").map((i) => i.kind)).toEqual(["negative_review", "review"]);
  });

  it("tiles take the negative threshold from core and say when writes are off", () => {
    const ts = tiles({ ...zero, approvals: { reply: 5, post: 1, changeset: 1, postedit: 2, total: 9 }, negativeMaxStars: 3 }, { writesOff: true }, t);
    expect(ts.map((x) => [x.label, x.n])).toEqual([
      ["Waiting for approval", 9], ["Negative reviews", 0], ["Unreplied reviews", 0],
      ["Profile changes", 0], ["Agent proposals", 0], ["Failed to publish", 0],
    ]);
    expect(ts[0]!.hint).toBe("5 replies · 1 post · 1 change set · 2 post edits");
    expect(ts[1]!.hint).toBe("1 to 3★, no reply yet");
    expect(ts[5]!.hint).toBe("Google writes are off");
  });

  it("links, chips and titles per kind", () => {
    expect(itemLink(item({ subject: "review", id: "r1" }), null, t)).toEqual({ href: "/reviews?review=r1", label: "Reply", primary: true });
    expect(itemLink(item({ kind: "approval", subject: "post", id: "p1" }), "w1", t).href).toBe("/approvals?ws=w1&item=post%3Ap1");
    expect(itemLink(item({ kind: "change", subject: "change", id: "c1" }), null, t)).toEqual({ href: "/locations/alerts?change=c1", label: "Compare", primary: false });
    expect(itemLink(item({ kind: "failed", subject: "reply", reviewId: "r9" }), null, t).href).toBe("/reviews?review=r9");
    expect(itemChip(item({}), NOW, t)).toEqual({ text: "No draft yet", tone: "neutral" });
    expect(itemChip(item({ kind: "approval", subject: "reply", provenance: { createdSurface: "mcp", createdByName: "Priya" } }), NOW, t).text).toBe("Drafted by Claude via MCP");
    expect(itemChip(item({ kind: "failed", subject: "reply", code: "google_writes_disabled" }), NOW, t).text).toBe(
      "google_writes_disabled: Google writes are turned off on this server",
    );
    expect(itemChip(item({ kind: "proposal", subject: "proposal", expiresAt: "2026-10-19T09:11:00.000Z" }), NOW, t).text).toBe(
      "Claude via MCP · expires in 11 min",
    );
    expect(itemTitle(item({ kind: "change", subject: "change", fields: ["regularHours"] }))).toBe("Hours changed outside OpenGMB");
  });

  it("Do these next: reviews, approvals, changes, then a post nudge; at most 3", () => {
    const c = { ...zero, reviews: { negative: 1, other: 2, total: 3 }, approvals: { ...zero.approvals, total: 1 }, changes: 1 };
    const cards = [{ lastPostAt: "2026-10-05T10:00:00Z" }];
    const a = nextActions(c, cards, NOW, t);
    expect(a.map((x) => x.title)).toEqual(["3 reviews need a reply", "1 item waits for your approval", "1 profile change found on Google"]);
    expect(a[0]!.text).toBe("1 rated 1 to 3★. Replies go to approval before they are posted.");
    expect(nextActions(zero, cards, NOW, t).map((x) => x.title)).toEqual(["No post in 13 days"]);
    expect(nextActions(zero, [{ lastPostAt: null }], NOW, t)[0]!.title).toBe("No posts yet");
  });
});
