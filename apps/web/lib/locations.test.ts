import { describe, expect, it } from "vitest";
import {
  locationLabel,
  SHIPPED_VIEWS,
  STATUS_FILTERS,
  filterLocations,
  groupSummary,
  importResultLabel,
  importResultTone,
  isUuid,
  loadedLine,
  locationHref,
  LOCATIONS_PAGE_SIZE,
  locationsHref,
  locationsPage,
  parseStatusFilter,
  pickerNote,
  queuedNote,
  ratingText,
  reviewCountText,
  selectionNote,
  setStatusMessage,
  statusCounts,
  viewTabs,
} from "./locations";

const loc = (o: Partial<Parameters<typeof filterLocations>[0][number]> = {}) => ({
  id: crypto.randomUUID(),
  name: "Rivermoor Main St",
  addressSummary: "[PLACEHOLDER] Main St, Rivermoor, TX 75940",
  phone: "(956) 555-0142",
  status: "active" as const,
  needsRelink: false,
  groups: [] as { id: string; name: string }[],
  ...o,
});

describe("views", () => {
  it("only shipped views become tabs, in canvas order, with the current one marked", () => {
    const tabs = viewTabs("list", {});
    expect(tabs.map((t) => t.label)).toEqual(["List", "Health", "Alerts", "Bulk edit"]);
    expect(tabs.map((t) => t.current)).toEqual([true, false, false, false]);
    expect(SHIPPED_VIEWS.has("health")).toBe(true);
    expect(SHIPPED_VIEWS.has("alerts")).toBe(true);
  });
  it("tabs carry the workspace and the alert count", () => {
    const ws = crypto.randomUUID();
    const tabs = viewTabs("bulk-edit", { ws, alerts: 4 });
    expect(tabs[0]!.href).toBe(`/locations?ws=${ws}`);
    expect(tabs[2]!.label).toBe("Alerts (4)");
    expect(tabs[3]!.href).toBe(`/locations/bulk-edit?ws=${ws}`);
  });
});

describe("hrefs", () => {
  it("builds list links without empty params", () => {
    expect(locationsHref({})).toBe("/locations");
    expect(locationsHref({ status: "all", q: "" })).toBe("/locations");
    expect(locationsHref({ ws: "w", status: "relink", group: "g", q: "main" })).toBe(
      "/locations?ws=w&status=relink&group=g&q=main",
    );
  });
  it("locationsHref carries the page from the second on", () => {
    expect(locationsHref({ page: 1 })).toBe("/locations");
    expect(locationsHref({ ws: "w", q: "main", page: 3 })).toBe("/locations?ws=w&q=main&page=3");
  });
  it("locationsPage cuts 1,000 rows into pages of LOCATIONS_PAGE_SIZE and clamps a stale page", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => i);
    const first = locationsPage(rows, 1);
    expect(first.rows).toHaveLength(LOCATIONS_PAGE_SIZE);
    expect(first.window).toMatchObject({ page: 1, pages: 20, from: 1, to: 50, hasPrev: false, hasNext: true });
    const last = locationsPage(rows, 99);
    expect(last.window).toMatchObject({ page: 20, from: 951, to: 1000, hasNext: false });
    expect(last.rows[0]).toBe(950);
    expect(locationsPage([], 1)).toMatchObject({ rows: [], window: { pages: 1, from: 0, to: 0 } });
    expect(locationsPage([1, 2, 3], 1).window.pages).toBe(1);
  });
  it("a location opens on its Overview", () => {
    expect(locationHref("abc")).toBe("/locations/abc");
  });
  it("isUuid", () => {
    expect(isUuid(crypto.randomUUID())).toBe(true);
    expect(isUuid("nope")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe("filters", () => {
  const rows = [
    loc({ name: "Rivermoor Main St", groups: [{ id: "g1", name: "Downtown" }] }),
    loc({ name: "Rivermoor North", addressSummary: "[PLACEHOLDER] Willow Creek Loop, Rivermoor, TX 75941" }),
    loc({ name: "Rivermoor South", addressSummary: "[PLACEHOLDER] Heron Creek Rd, Rivermoor, TX 75943", needsRelink: true, groups: [{ id: "g2", name: "South Rivermoor" }] }),
    loc({ name: "Rivermoor Orchard Hwy", addressSummary: "[PLACEHOLDER] US-83, Orchard, TX 78076", status: "inactive", groups: [{ id: "g2", name: "South Rivermoor" }] }),
  ];
  it("parses the status filter, defaulting to all", () => {
    expect(parseStatusFilter("inactive")).toBe("inactive");
    expect(parseStatusFilter("bogus")).toBe("all");
    expect(parseStatusFilter(undefined)).toBe("all");
    expect(STATUS_FILTERS.map((f) => f.label)).toEqual(["All", "Active", "Inactive", "Needs re-link"]);
  });
  it("counts each pill on the unfiltered rows", () => {
    expect(statusCounts(rows)).toEqual({ all: 4, active: 3, inactive: 1, relink: 1 });
  });
  it("filters by status, group and a case-insensitive search over name and address", () => {
    expect(filterLocations(rows, { status: "relink" }).map((r) => r.name)).toEqual(["Rivermoor South"]);
    expect(filterLocations(rows, { group: "g2" }).map((r) => r.name)).toEqual([
      "Rivermoor South",
      "Rivermoor Orchard Hwy",
    ]);
    expect(filterLocations(rows, { q: "  NORTH " }).map((r) => r.name)).toEqual(["Rivermoor North"]);
    expect(filterLocations(rows, { q: "main st, rivermoor" })).toHaveLength(1);
    expect(filterLocations(rows, { status: "active", group: "g2" }).map((r) => r.name)).toEqual([
      "Rivermoor South",
    ]);
  });
});

describe("cells", () => {
  it("rating and review count", () => {
    expect(ratingText(4.6123)).toBe("4.6");
    expect(ratingText(null)).toBe("–");
    expect(reviewCountText(212)).toBe("212 reviews");
    expect(reviewCountText(1)).toBe("1 review");
    expect(reviewCountText(0)).toBe("No reviews");
  });
});

describe("import copy", () => {
  it("loaded line", () => {
    expect(loadedLine("Synectus GBP", 7)).toBe("Synectus GBP · 7 locations loaded");
    expect(loadedLine("Synectus GBP", 1)).toBe("Synectus GBP · 1 location loaded");
  });
  it("picker notes (re-link stays selectable: e824537)", () => {
    expect(pickerNote({ alreadyImported: true, needsRelink: true, importedWorkspace: { name: "Rivermoor Pain Clinic" } })).toBe(
      " - imported in Rivermoor Pain Clinic, needs re-link",
    );
    expect(pickerNote({ alreadyImported: true, needsRelink: false, importedWorkspace: { name: "Northside Chiro" } })).toBe(
      " - already imported in Northside Chiro",
    );
    expect(pickerNote({ alreadyImported: true, needsRelink: false, importedWorkspace: null })).toBe(
      " - active in another organization",
    );
    expect(pickerNote({ alreadyImported: false, needsRelink: false, importedWorkspace: null })).toBe("");
  });
  it("selection note and the limit", () => {
    expect(selectionNote(3, 100)).toEqual({ text: "3 selected. Up to 100 at a time.", over: false });
    expect(selectionNote(112, 100)).toEqual({ text: "Pick up to 100 locations at a time.", over: true });
    expect(selectionNote(100, 100).over).toBe(false);
  });
  it("result labels and tones", () => {
    expect(importResultLabel("relinked")).toBe("Re-linked to this Google connection");
    expect(importResultLabel("not_found")).toBe("not found");
    expect(importResultLabel("exists_inactive")).toBe("exists inactive");
    expect(importResultTone("relinked")).toBe("good");
    expect(importResultTone("imported")).toBe("neutral");
    expect(importResultTone("already_imported")).toBe("neutral");
    expect(importResultTone("exists_inactive")).toBe("warn");
    expect(importResultTone("conflict")).toBe("bad");
    expect(importResultTone("not_found")).toBe("bad");
  });
  it("queued note names the imported and re-linked locations", () => {
    expect(queuedNote(["Rivermoor South"])).toBe(
      "Rivermoor South: a review sync and a performance backfill are queued.",
    );
    expect(queuedNote(["A", "B"])).toBe(
      "A, B: a review sync and a performance backfill are queued for each.",
    );
    expect(queuedNote([])).toBeNull();
  });
});

describe("groups", () => {
  it("summarises members by name in list order", () => {
    const locs = [loc({ id: "1", name: "Rivermoor Main St" }), loc({ id: "2", name: "Rivermoor Medical Plaza" })];
    expect(groupSummary(["2", "1"], locs)).toBe("2 locations · Rivermoor Main St, Rivermoor Medical Plaza");
    expect(groupSummary(["1"], locs)).toBe("1 location · Rivermoor Main St");
    expect(groupSummary([], locs)).toBe("No locations");
  });
});

describe("setStatusMessage", () => {
  it("maps results and errors to the inline message", () => {
    expect(setStatusMessage({ ok: false, error: { code: "FORBIDDEN", message: "Role client_viewer lacks location:manage" } })).toBe(
      "FORBIDDEN: Role client_viewer lacks location:manage",
    );
    expect(setStatusMessage({ ok: true, data: { results: [{ locationId: "x", result: "conflict" }] } })).toBe(
      "That Google location is already active somewhere else, so it cannot be activated here.",
    );
    expect(setStatusMessage({ ok: true, data: { results: [{ locationId: "x", result: "not_found" }] } })).toBe(
      "NOT_FOUND: Location not found",
    );
    expect(setStatusMessage({ ok: true, data: { results: [{ locationId: "x", result: "updated" }] } })).toBeNull();
  });
});

describe("locationLabel", () => {
  it("is Title (address)", () => expect(locationLabel({ name: "Ace Dental", addressSummary: "1 Main St, Austin" })).toBe("Ace Dental (1 Main St, Austin)"));
  it("prefers title over name", () => expect(locationLabel({ title: "Ace", name: "ace-1", addressSummary: "A" })).toBe("Ace (A)"));
  it("falls back to phone for service-area businesses, then the bare name", () => {
    expect(locationLabel({ name: "Ace", addressSummary: null, phone: "+1 555 0100" })).toBe("Ace (+1 555 0100)");
    expect(locationLabel({ name: "Ace", addressSummary: " ", phone: "" })).toBe("Ace");
    expect(locationLabel({ title: "Ace" })).toBe("Ace");
  });
});
