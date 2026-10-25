import { describe, expect, it } from "vitest";
import {
  GOOGLE_NOTIFICATION_KINDS,
  GEOGRID_BUDGET_EXCEEDED_KIND,
  MEDIA_CUSTOMER_PHOTO_KIND,
  PROFILE_CHANGED_KIND,
  REVIEW_ASSIGNED_KIND,
  REVIEW_NEGATIVE_KIND,
} from "@opengmb/core";
import { linkLabel, listFooter, MAX_SHOWN, notificationsHref, PAGE, parseShow, PREFERENCE_ROWS } from "./notification-list";

// approval.requested is APPROVAL_REQUESTED_KIND in packages/core/src/approvals.ts, which core's index does not export.
const CORE_KINDS = [
  ...Object.values(GOOGLE_NOTIFICATION_KINDS),
  REVIEW_NEGATIVE_KIND,
  REVIEW_ASSIGNED_KIND,
  PROFILE_CHANGED_KIND,
  MEDIA_CUSTOMER_PHOTO_KIND,
  GEOGRID_BUDGET_EXCEEDED_KIND,
  "approval.requested",
];

describe("kinds", () => {
  it("canary: the preferences table lists exactly the 9 kinds core creates", () => {
    expect(CORE_KINDS).toHaveLength(9);
    expect(PREFERENCE_ROWS.map((r) => r.kind).sort()).toEqual([...CORE_KINDS].sort());
  });

  it("gives every core kind a link label, and none when there is no link", () => {
    for (const k of CORE_KINDS) expect(linkLabel(k, "/somewhere")).not.toBe("Open");
    expect(linkLabel("review.negative", "/reviews?review=1")).toBe("Open review");
    expect(linkLabel("profile.changed", "/locations/1/changes")).toBe("See changes");
    expect(linkLabel("google.new_review", null)).toBeNull();
    expect(linkLabel("something.new", "/x")).toBe("Open");
  });

  it("says what is true today: only approval requests are emailed, everything is in the digest", () => {
    expect(PREFERENCE_ROWS.filter((r) => r.email).map((r) => r.kind)).toEqual(["approval.requested"]);
    expect(PREFERENCE_ROWS.every((r) => r.inApp && r.digest)).toBe(true);
    expect(PREFERENCE_ROWS.find((r) => r.kind === REVIEW_NEGATIVE_KIND)?.label).toBe("Negative review (1-3★)");
  });
});

describe("parseShow", () => {
  it("defaults to 10, rounds up to tens and caps at 100", () => {
    expect([PAGE, MAX_SHOWN]).toEqual([10, 100]);
    expect(parseShow(undefined)).toBe(10);
    expect(parseShow("abc")).toBe(10);
    expect(parseShow("-5")).toBe(10);
    expect(parseShow("20")).toBe(20);
    expect(parseShow("25")).toBe(30);
    expect(parseShow("5000")).toBe(100);
  });
});

describe("notificationsHref", () => {
  it("keeps only the params that differ from the defaults", () => {
    expect(notificationsHref({ unread: false, show: 10 })).toBe("/settings/notifications");
    expect(notificationsHref({ unread: true, show: 20 })).toBe("/settings/notifications?filter=unread&show=20");
  });
});

describe("listFooter", () => {
  it("offers Older while the page is full and below the cap", () => {
    expect(listFooter(10, 10, false)).toEqual({
      caption: "Showing the 10 newest",
      olderHref: "/settings/notifications?show=20",
    });
    expect(listFooter(20, 20, true).olderHref).toBe("/settings/notifications?filter=unread&show=30");
  });

  it("stops at the cap and says so", () => {
    expect(listFooter(100, 100, false)).toEqual({
      caption: "Showing the 100 newest. Older notifications are kept but not listed here.",
      olderHref: null,
    });
  });

  it("canary: a short page has no Older link", () => {
    expect(listFooter(7, 10, false)).toEqual({ caption: "Showing all 7", olderHref: null });
    expect(listFooter(0, 10, false)).toEqual({ caption: "", olderHref: null });
  });
});
