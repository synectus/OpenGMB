import { describe, expect, it } from "vitest";
import {
  attentionItems,
  bookingTypeLabel,
  changeSetLine,
  cronTimeUtc,
  daysAgoText,
  deltaText,
  last28Days,
  locationTabs,
  standingLabel,
} from "./location-hub";

const ID = "11111111-1111-4111-8111-111111111111";
const base = {
  locationId: ID,
  stats: { reviews: { unreplied: 0 }, openChanges: 0 },
  changeSets: [] as { id: string; status: string; fieldNames: string[]; locationCount: number; createdByName: string | null; createdSurface: string }[],
  photos: { newestDays: 3 } as { newestDays: number | null } | null,
};
const cfg = { snapshotUtc: "03:30", recentPhotoDays: 30 };

describe("attentionItems", () => {
  it("nothing to do gives an empty list", () => {
    expect(attentionItems(base, cfg)).toEqual([]);
  });
  it("lists replies, changes, pending change sets and old photos with their links, in that order", () => {
    const items = attentionItems(
      {
        ...base,
        stats: { reviews: { unreplied: 3 }, openChanges: 2 },
        changeSets: [
          { id: "cs1", status: "pending_approval", fieldNames: ["description"], locationCount: 6, createdByName: "Marcus", createdSurface: "ui" },
          { id: "cs2", status: "approved", fieldNames: ["title"], locationCount: 1, createdByName: "Priya", createdSurface: "ui" },
        ],
        photos: { newestDays: 41 },
      },
      cfg,
    );
    expect(items.map((i) => i.text)).toEqual([
      "3 reviews need a reply",
      "2 profile changes found by the nightly snapshot (03:30 UTC)",
      "Change set pending approval: description on 6 locations, proposed by Marcus",
      "Newest photo is 41 days old",
    ]);
    expect(items.map((i) => i.link)).toEqual(["Reviews", "Changes", "Approvals", "Photos"]);
    expect(items[0]!.href).toBe(`/reviews?replied=no&loc=${ID}`);
    expect(items[1]!.href).toBe(`/locations/${ID}/changes`);
    expect(items[2]!.href).toBe("/approvals?tab=changeset&item=changeset%3Acs1");
    expect(items[3]!.href).toBe(`/locations/${ID}/media`);
  });
  it("singular forms, no photos at all, unknown photos", () => {
    const one = attentionItems({ ...base, stats: { reviews: { unreplied: 1 }, openChanges: 1 }, photos: { newestDays: null } }, cfg);
    expect(one.map((i) => i.text)).toEqual([
      "1 review needs a reply",
      "1 profile change found by the nightly snapshot (03:30 UTC)",
      "No photos yet",
    ]);
    expect(attentionItems({ ...base, photos: null }, cfg)).toEqual([]);
  });
});

describe("formatting", () => {
  it("change set line", () => {
    expect(changeSetLine({ fieldNames: ["regularHours"], locationCount: 1 })).toBe("regularHours on 1 location");
  });
  it("the last 28 complete days end yesterday, in the client's zone", () => {
    expect(last28Days(new Date("2026-10-18T01:00:00Z"), "UTC")).toEqual({ from: "2026-09-20", to: "2026-10-17" });
    // 01:00 UTC is already the 18th in Kolkata but still the 17th in Los Angeles
    expect(last28Days(new Date("2026-10-18T01:00:00Z"), "Asia/Kolkata")).toEqual({ from: "2026-09-20", to: "2026-10-17" });
    expect(last28Days(new Date("2026-10-18T01:00:00Z"), "America/Los_Angeles")).toEqual({ from: "2026-09-19", to: "2026-10-16" });
  });
  it("days ago", () => {
    const now = new Date("2026-10-18T12:00:00Z");
    expect(daysAgoText("2026-10-13T14:00:00Z", now)).toBe("4 days ago");
    expect(daysAgoText("2026-10-17T11:00:00Z", now)).toBe("1 day ago");
    expect(daysAgoText("2026-10-18T09:00:00Z", now)).toBe("today");
  });
  it("cron to UTC clock time", () => {
    expect(cronTimeUtc("30 3 * * *")).toBe("03:30");
    expect(cronTimeUtc("0 14 1 * *")).toBe("14:00");
  });
  it("delta percent from a fraction", () => {
    expect(deltaText(0.1234)).toBe("+12%");
    expect(deltaText(-0.04)).toBe("-4%");
    expect(deltaText(0)).toBe("0%");
    expect(deltaText(null)).toBe("–");
  });
  it("standing and booking labels", () => {
    expect(standingLabel("good_standing")).toBe("In good standing");
    expect(standingLabel("verify")).toBe("Verification needed");
    expect(standingLabel("anything else")).toBe("Unknown");
    expect(bookingTypeLabel("ONLINE_APPOINTMENT")).toBe("Online appointment");
  });
});

describe("locationTabs", () => {
  const base = `/locations/${ID}`;
  it("Overview first, Changes with a count, the current tab by path", () => {
    const tabs = locationTabs(ID, `${base}/health`, 2);
    expect(tabs.map((t) => t.label)).toEqual(["Overview", "Profile", "Photos", "Health", "Changes (2)", "Suspension", "Citations"]);
    expect(tabs.find((t) => t.current)?.label).toBe("Health");
    expect(tabs[2]!.href).toBe(`${base}/media`);
  });
  it("Overview is current only on the index; no count at zero", () => {
    expect(locationTabs(ID, base, 0).find((t) => t.current)?.label).toBe("Overview");
    expect(locationTabs(ID, `${base}/changes`, 0)[4]!.label).toBe("Changes");
  });
});
