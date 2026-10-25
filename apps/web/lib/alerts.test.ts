import { describe, expect, it } from "vitest";
import { makeTimeFormat } from "./time-format";
import type { ChangeData } from "./changes";
import {
  activity,
  alertsHref,
  changeSummary,
  foundCell,
  hasNarrowing,
  listInput,
  parseAlertFilters,
  runSequentially,
  selectableIds,
  sourceLabel,
  toggleAllSelected,
} from "./alerts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const change = (over: Partial<ChangeData> = {}): ChangeData => ({
  id: A,
  locationId: "l1",
  locationName: "Rivermoor Main St",
  workspaceId: "w",
  detectedAt: "2026-10-18T03:30:05.000Z",
  source: "nightly",
  fieldPaths: ["regularHours", "websiteUri"],
  before: { fields: {}, attributes: {} },
  after: { fields: {}, attributes: {} },
  googleSuggested: false,
  status: "open",
  resolvedBy: null,
  resolvedByName: null,
  resolvedAt: null,
  revertChangeSetId: null,
  revertChangeSetStatus: null,
  revertChangeSetSurface: null,
  can: { accept: true, revert: true, dismiss: true },
  ...over,
});

describe("filters in the URL", () => {
  it("parses with defaults and drops junk", () => {
    expect(parseAlertFilters({})).toEqual({ status: "open", source: "all", field: "all", loc: null, group: null, ws: null, change: null });
    expect(parseAlertFilters({ status: "all", source: "google", field: "hours", loc: A, group: "nope", change: B })).toMatchObject({
      status: "all", source: "google", field: "hours", loc: A, group: null, change: B,
    });
    expect(parseAlertFilters({ source: "pubsub", field: "address" })).toMatchObject({ source: "all", field: "all" });
  });
  it("round-trips through alertsHref, defaults left out, a patch clears the selection", () => {
    const f = parseAlertFilters({ field: "website", ws: B, change: A });
    expect(alertsHref(parseAlertFilters({}))).toBe("/locations/alerts");
    const u = new URL(alertsHref(f, { source: "snapshot" }), "http://x");
    expect(u.pathname).toBe("/locations/alerts");
    expect(Object.fromEntries(u.searchParams)).toEqual({ source: "snapshot", field: "website", ws: B });
    expect(parseAlertFilters(Object.fromEntries(new URL(alertsHref(f), "http://x").searchParams))).toEqual(f);
  });
  it("list input maps the field group and the source", () => {
    expect(listInput(parseAlertFilters({ field: "hours", source: "google", status: "all", group: A }))).toEqual({
      fields: ["regularHours", "specialHours"],
      googleSuggested: true,
      groupId: A,
      limit: 200,
    });
    expect(listInput(parseAlertFilters({ field: "phone", source: "snapshot", loc: A, ws: B }))).toEqual({
      status: "open", fields: ["phoneNumbers"], googleSuggested: false, locationId: A, workspaceId: B, limit: 200,
    });
  });
  it("narrowing means anything but status and the selection", () => {
    expect(hasNarrowing(parseAlertFilters({ status: "all", change: A }))).toBe(false);
    expect(hasNarrowing(parseAlertFilters({ group: A }))).toBe(true);
  });
});


const utc = makeTimeFormat({ zones: [{ id: "w", timeZone: "UTC", dateFormat: "YYYY-MM-DD" }], workspaceId: "w" });
const ist = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

describe("cells", () => {
  it("summary, source and found", () => {
    expect(changeSummary(["regularHours", "websiteUri"])).toBe("Hours, Website changed");
    expect(changeSummary(["categories", "attributes/has_wifi", "storefrontAddress"])).toBe("Categories, Attribute has wifi, Address changed");
    expect(sourceLabel(change())).toBe("Nightly snapshot");
    expect(sourceLabel(change({ googleSuggested: true, source: "push" }))).toBe("Google suggestion");
    expect(foundCell(change().detectedAt, utc)).toBe("2026-10-18 03:30");
    expect(foundCell(change().detectedAt, ist, "w")).toBe("18/10/2026 09:00");
  });
});

describe("selection and bulk", () => {
  const list = [change(), change({ id: B, can: { accept: false, revert: false, dismiss: false } })];
  it("only rows you can accept and dismiss are selectable", () => {
    expect(selectableIds(list)).toEqual([A]);
    expect(toggleAllSelected([], list)).toEqual([A]);
    expect(toggleAllSelected([A], list)).toEqual([]);
  });
  it("canary: runs one after another, keeps going after a failure, reports CODE: message", async () => {
    const order: string[] = [];
    const r = await runSequentially([A, B], async (id) => {
      order.push(id);
      return id === A ? { ok: true } : { ok: false, error: { code: "CONFLICT", message: "Only an open change can be resolved" } };
    });
    expect(order).toEqual([A, B]);
    expect(r).toEqual({ done: [A], errors: [{ id: B, message: "CONFLICT: Only an open change can be resolved" }] });
  });
});

describe("activity", () => {
  it("resolved changes, newest decision first, with the revert note", () => {
    const rows = activity(
      [
        change({ id: "1", status: "accepted", resolvedByName: "Priya", resolvedAt: "2026-10-15T10:12:00Z", fieldPaths: ["websiteUri"], locationName: "Rivermoor Medical Plaza" }),
        change({ id: "2", status: "open" }),
        change({ id: "3", status: "reverted", resolvedByName: "Marcus", resolvedAt: "2026-10-16T09:30:00Z", fieldPaths: ["regularHours"], locationName: "Rivermoor North", revertChangeSetStatus: "approved" }),
      ],
      { writesOff: true },
      utc,
    );
    expect(rows).toEqual([
      { id: "3", time: "2026-10-16 09:30", text: "Marcus reverted Hours at Rivermoor North", note: "Revert change set: approved, Apply fails while writes are off" },
      { id: "1", time: "2026-10-15 10:12", text: "Priya accepted Website at Rivermoor Medical Plaza", note: null },
    ]);
  });
});
