import { describe, expect, it } from "vitest";
import { SHIPPED_VIEWS, parseView, reviewsTabs } from "./reviews-views";

describe("reviews views", () => {
  it("ships inbox, bulk, analytics, requests and queue", () => {
    expect([...SHIPPED_VIEWS].sort()).toEqual(["analytics", "bulk", "inbox", "queue", "requests"]);
  });
  it("parseView only returns shipped views the role may open", () => {
    expect(parseView(undefined, { canDraft: true })).toBe("inbox");
    expect(parseView("bulk", { canDraft: true })).toBe("bulk");
    expect(parseView("bulk", { canDraft: false })).toBe("inbox");
    expect(parseView("analytics", { canDraft: true })).toBe("analytics");
    expect(parseView("requests", { canDraft: false })).toBe("requests");
    expect(parseView("nope", { canDraft: true })).toBe("inbox");
    expect(parseView("queue", { canDraft: false })).toBe("queue");
  });
  it("builds the tabs in order, hiding what the role lacks", () => {
    const full = reviewsTabs("bulk", { hasQueue: true, canDraft: true, ws: "w1" });
    expect(full.map((t) => t.label)).toEqual(["Inbox", "Bulk reply", "Analytics", "Requests", "Approval queue"]);
    expect(full.find((t) => t.current)?.label).toBe("Bulk reply");
    expect(full[1]!.href).toBe("/reviews?view=bulk&ws=w1");
    expect(full.map((t) => t.key)).toEqual(["inbox", "bulk", "analytics", "requests", "queue"]);
    expect(full[2]!.href).toBe("/reviews?view=analytics&ws=w1");
    expect(full[3]!.href).toContain("view=requests");
    const linked = reviewsTabs("inbox", { hasQueue: true, canDraft: true, queueTab: { href: "/approvals?tab=reply", label: "Approval queue (4)" } });
    expect(linked.at(-1)).toMatchObject({ key: "queue", href: "/approvals?tab=reply", label: "Approval queue (4)", current: false });
    const viewer = reviewsTabs("inbox", { hasQueue: false, canDraft: false });
    expect(viewer.map((t) => t.label)).toEqual(["Inbox", "Analytics", "Requests"]);
  });
});
