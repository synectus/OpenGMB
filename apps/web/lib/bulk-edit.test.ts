import { PROFILE_BATCH_MAX_LOCATIONS } from "@opengmb/core";
import { describe, expect, it } from "vitest";
import { makeTimeFormat } from "./time-format";
import {
  allPicked,
  BULK_MAX_LOCATIONS,
  buildAddCategories,
  buildAddServices,
  buildFields,
  buildSkipUnoffered,
  categoriesAfter,
  canPropose,
  capNote,
  changedDays,
  defaultWeek,
  emptyForm,
  endNote,
  formProblemList,
  formProblems,
  ineligibleReason,
  previewRow,
  quickSelect,
  replaceWarning,
  resultRows,
  setMeta,
  setTitle,
  toggleAllIds,
  type BulkLoc,
  type PreviewLike,
  type SetLike,
} from "./bulk-edit";

const utcTf = makeTimeFormat({ zones: [], workspaceId: null });
const istTf = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

const loc = (id: string, over: Partial<BulkLoc> = {}): BulkLoc => ({
  id,
  name: id,
  status: "active",
  googleLocationId: `locations/${id}`,
  needsRelink: false,
  ...over,
});
const LOCS = [loc("main"), loc("north"), loc("south", { needsRelink: true }), loc("orchard", { status: "inactive" }), loc("x", { googleLocationId: null })];

describe("locations", () => {
  it("canary: each reason a location cannot be edited", () => {
    expect(ineligibleReason(loc("ok"))).toBeNull();
    expect(ineligibleReason(LOCS[2]!)).toBe("not linked to Google");
    expect(ineligibleReason(LOCS[3]!)).toBe("inactive");
    expect(ineligibleReason(LOCS[4]!)).toBe("not linked to Google");
  });
  it("quick select keeps only editable members; All toggles editable ones", () => {
    expect(quickSelect({ id: "g", name: "South Rivermoor", locationIds: ["south", "orchard", "north"] }, LOCS)).toEqual(["north"]);
    expect(toggleAllIds([], LOCS)).toEqual(["main", "north"]);
    expect(toggleAllIds(["main", "north"], LOCS)).toEqual([]);
  });
});

describe("one change covers a limited number of locations (U8)", () => {
  const many = Array.from({ length: 250 }, (_, i) => loc(`l${String(i).padStart(3, "0")}`));
  it("the web cap is the core cap", () => {
    expect(BULK_MAX_LOCATIONS).toBe(PROFILE_BATCH_MAX_LOCATIONS);
  });
  it("All picks the first batch only; a second press clears; the group quick select is cut the same way", () => {
    const first = toggleAllIds([], many);
    expect(first).toHaveLength(BULK_MAX_LOCATIONS);
    expect(first[0]).toBe("l000");
    expect(allPicked(first, many)).toBe(true);
    expect(toggleAllIds(first, many)).toEqual([]);
    expect(quickSelect({ id: "g", name: "All", locationIds: many.map((l) => l.id) }, many)).toHaveLength(BULK_MAX_LOCATIONS);
    expect(allPicked([], many)).toBe(false);
    expect(allPicked([], [])).toBe(false);
  });
  it("the note appears only when more locations could be picked than one change takes", () => {
    expect(capNote(many)).toBe("One change covers up to 100 locations. All picks the first 100 by name; make another change for the other 150.");
    expect(capNote(LOCS)).toBeNull();
  });
});

describe("fields", () => {
  it("the week grid: Monday to Friday open by default; edits are marked changed", () => {
    const week = defaultWeek();
    expect(week.map((d) => d.closed)).toEqual([false, false, false, false, false, true, true]);
    const edited = week.map((d) => (d.day === "SATURDAY" ? { ...d, closed: false, open: "09:00", close: "13:00" } : d));
    expect(changedDays(edited)).toEqual(["SATURDAY"]);
  });
  it("only ticked fields are sent, each in core's shape", () => {
    const f = emptyForm();
    f.use.regularHours = true;
    f.use.websiteUri = true;
    f.use.categories = true;
    f.use.title = false;
    f.use.openingDate = true;
    f.use.specialHours = true;
    f.categories = {
      mode: "replace",
      add: [],
      primary: "categories/gcid:pain_control_clinic",
      additional: ["categories/gcid:medical_clinic"],
    };
    f.openingDate = "2019-03-01";
    const out = buildFields(f, { specialHours: { specialHourPeriods: [] }, attributes: {} });
    expect(Object.keys(out).sort()).toEqual(["categories", "openingDate", "regularHours", "specialHours", "websiteUri"]);
    expect(out.websiteUri).toBeNull(); // empty clears it
    expect((out.regularHours as { periods: unknown[] }).periods).toHaveLength(5);
    expect((out.regularHours as { periods: { openDay: string; openTime: unknown }[] }).periods[0]).toEqual({
      openDay: "MONDAY",
      openTime: { hours: 9, minutes: 0 },
      closeDay: "MONDAY",
      closeTime: { hours: 17, minutes: 0 },
    });
    expect(out.categories).toEqual({
      primaryCategory: { name: "categories/gcid:pain_control_clinic" },
      additionalCategories: [{ name: "categories/gcid:medical_clinic" }],
    });
    expect(out.openingDate).toEqual({ year: 2019, month: 3, day: 1 });
  });
  it("every day closed clears the hours; untouched form sends nothing", () => {
    const f = emptyForm();
    f.use.regularHours = true;
    f.week = f.week.map((d) => ({ ...d, closed: true }));
    expect(buildFields(f, { specialHours: null, attributes: {} })).toEqual({ regularHours: null });
    expect(buildFields(emptyForm(), { specialHours: null, attributes: {} })).toEqual({});
  });
  it("problems name the field", () => {
    const f = emptyForm();
    f.use.regularHours = true;
    f.use.title = true;
    f.use.openingDate = true;
    f.week[0] = { ...f.week[0]!, open: "9am" };
    f.openingDate = "03/01/2019";
    expect(formProblems(f)).toEqual([
      "Monday: use HH:MM, for example 09:00",
      "Title: cannot be empty",
      "Opening date: use YYYY-MM-DD",
    ]);
  });
});

describe("preview", () => {
  const p = (over: Partial<PreviewLike> = {}): PreviewLike => ({
    locationId: "main",
    locationName: "Rivermoor Main St",
    error: null,
    changes: [{ field: "regularHours" }, { field: "specialHours" }, { field: "attributes/wheelchair_accessible_entrance" }],
    updateMask: ["regularHours", "specialHours"],
    attributeMask: ["attributes/wheelchair_accessible_entrance"],
    noChange: false,
    guardrail: { ok: true, violations: [] },
    ...over,
  });
  it("rows read like the board", () => {
    expect(previewRow(p())).toMatchObject({
      changes: "Regular hours, Special hours, 1 attribute",
      mask: "regularHours, specialHours, attributes/wheelchair_accessible_entrance",
      check: "No guardrail violations.",
      result: "Ready",
    });
    expect(previewRow(p({ noChange: true, changes: [], updateMask: [], attributeMask: [], guardrail: null }))).toMatchObject({
      changes: "Already matches Google",
      mask: "·",
      check: "·",
      result: "no change",
    });
    expect(previewRow(p({ guardrail: { ok: false, violations: [{ severity: "block" }, { severity: "warn" }] } }))).toMatchObject({
      check: "1 blocking, 1 warning",
      result: "blocked",
    });
    expect(previewRow(p({ error: "connection_removed" }))).toMatchObject({ result: "error", error: "connection_removed" });
  });
  it("propose needs one changing location and no block; errors are skipped", () => {
    expect(canPropose(null)).toBe(false);
    expect(canPropose([p()])).toBe(true);
    expect(canPropose([p(), p({ error: "connection_removed" })])).toBe(true);
    expect(canPropose([p({ noChange: true })])).toBe(false);
    expect(canPropose([p(), p({ guardrail: { ok: false, violations: [{ severity: "block" }] } })])).toBe(false);
  });
});

describe("change set history", () => {
  const set = (over: Partial<SetLike> = {}): SetLike => ({
    id: "s",
    status: "pending_approval",
    createdAt: "2026-10-17T14:02:30.000Z",
    updatedAt: "2026-10-17T14:02:30.000Z",
    createdByName: "Marcus",
    approvedByName: null,
    rejectReason: null,
    fields: { fields: { description: "x" }, attributes: {} },
    targets: [
      { locationName: "A", status: "pending", error: null, appliedAt: null, changes: [{ field: "description" }] },
      { locationName: "B", status: "no_change", error: null, appliedAt: null, changes: [] },
    ],
    ...over,
  });
  it("title and meta per status", () => {
    expect(setTitle(set())).toBe("Description");
    expect(setMeta(set(), utcTf)).toBe("1 location | proposed 2026-10-17 14:02");
    expect(setMeta(set(), istTf)).toBe("1 location | proposed 17/10/2026 19:32");
    expect(setMeta(set({ status: "approved", approvedByName: "Dr. Ramos" }), utcTf)).toBe(
      "1 location | proposed 2026-10-17, approved by Dr. Ramos",
    );
    expect(
      setMeta(set({ status: "failed", updatedAt: "2026-10-15T16:20:00.000Z", targets: [{ locationName: "A", status: "failed", error: "google_writes_disabled", appliedAt: null, changes: [{ field: "websiteUri" }] }] }), utcTf),
    ).toBe("1 location | applied 2026-10-15 16:20");
  });
  it("end notes: rejected is cancelled with a reason", () => {
    expect(endNote(set({ status: "cancelled", rejectReason: "Keep Saturday closed at Del Mar." }))).toBe(
      "Reject reason: Keep Saturday closed at Del Mar.",
    );
    expect(endNote(set({ status: "cancelled" }))).toBe("Someone cancelled it before it was applied. Nothing was sent to Google.");
    expect(endNote(set({ status: "blocked" }))).toBe("A guardrail blocked it at proposal, so it never reached approval.");
    expect(endNote(set())).toBeNull();
  });
  it("result rows skip no_change targets and label the code", () => {
    const rows = resultRows(set({ targets: [
      { locationName: "Rivermoor Orchard Hwy", status: "failed", error: "location_inactive", appliedAt: null, changes: [{ field: "websiteUri" }] },
      { locationName: "B", status: "no_change", error: null, appliedAt: null, changes: [] },
    ] }));
    expect(rows).toEqual([
      { location: "Rivermoor Orchard Hwy", status: "failed", code: "location_inactive", reason: "This location is inactive", fields: "Website" },
    ]);
  });
});

describe("services: add by default, replace only by choice", () => {
  const nothing = { specialHours: null, attributes: {} };
  const on = () => {
    const f = emptyForm();
    f.use.serviceItems = true;
    f.services = { lines: "Whitening\n Bleaching \n", category: "categories/gcid:dentist", mode: "add" };
    return f;
  };
  const item = (displayName: string) => ({
    freeFormServiceItem: { category: "categories/gcid:dentist", label: { displayName } },
  });

  it("canary: add mode is the default", () => {
    expect(emptyForm().services.mode).toBe("add");
  });
  it("add mode sends the lines as addServiceItems and never as a whole serviceItems list", () => {
    expect(buildFields(on(), nothing)).toEqual({});
    expect(buildAddServices(on())).toEqual([item("Whitening"), item("Bleaching")]);
  });
  it("replace mode keeps the whole-list serviceItems and sends no additions", () => {
    const f = on();
    f.services.mode = "replace";
    expect(buildFields(f, nothing)).toEqual({ serviceItems: [item("Whitening"), item("Bleaching")] });
    expect(buildAddServices(f)).toBeUndefined();
  });
  it("an unticked field adds nothing; the category defaults to the primary category", () => {
    const f = on();
    f.use.serviceItems = false;
    expect(buildAddServices(f)).toBeUndefined();
    f.use.serviceItems = true;
    f.services.category = "";
    f.use.categories = true;
    f.categories = { mode: "replace", add: [], primary: "categories/gcid:dentist", additional: [] };
    expect(buildAddServices(f)).toEqual([item("Whitening"), item("Bleaching")]);
    // Adding categories picks nothing for the services: the category must be chosen.
    f.categories.mode = "add";
    expect(buildAddServices(f)?.[0]?.freeFormServiceItem.category).toBe("");
  });
  it("names the services problems before asking core", () => {
    const f = on();
    f.services.lines = " \n";
    expect(formProblems(f)).toEqual(["Services: type at least one service to add"]);
    f.services = { ...f.services, lines: "Whitening", category: "" };
    expect(formProblems(f)).toEqual(["Services: choose the category for the new services"]);
  });
  it("replaceWarning counts what a replace would remove at one location", () => {
    const priced = { currencyCode: "USD", units: "50" };
    const current = {
      fields: {
        serviceItems: [
          { ...item("Whitening"), price: priced },
          { ...item("Checkup"), price: priced },
          { freeFormServiceItem: { category: "categories/gcid:ortho", label: { displayName: "Braces" } }, price: priced },
          { freeFormServiceItem: { category: "categories/gcid:perio", label: { displayName: "Scaling" } } },
          { structuredServiceItem: { serviceTypeId: "job_type_id:x", description: "d" } },
        ],
      },
      attributes: {},
    };
    expect(replaceWarning("Main St", current, "categories/gcid:dentist")).toBe(
      "Main St: 5 services, 3 with prices, 2 other categories, 1 from Google's list will be removed",
    );
    expect(replaceWarning("Empty", { fields: { serviceItems: null }, attributes: {} }, "x")).toBeNull();
    expect(replaceWarning("Gone", null, "x")).toBeNull();
  });
});

describe("categories: add by default, replace only by choice", () => {
  const nothing = { specialHours: null, attributes: {} };
  const dentist = "categories/gcid:dentist";
  const ortho = "categories/gcid:orthodontist";

  it("canary: add mode is the default, and an unticked field sends nothing", () => {
    const f = emptyForm();
    expect(f.categories.mode).toBe("add");
    f.categories.add = [dentist];
    expect(buildAddCategories(f)).toBeUndefined();
    expect(buildFields(f, nothing)).toEqual({});
  });
  it("add mode sends the picked ids as addCategories and never as a whole categories value", () => {
    const f = emptyForm();
    f.use.categories = true;
    f.categories.add = [dentist, ortho];
    expect(buildAddCategories(f)).toEqual([{ name: dentist }, { name: ortho }]);
    expect(buildFields(f, nothing)).toEqual({});
  });
  it("replace mode sends the whole value and no additions", () => {
    const f = emptyForm();
    f.use.categories = true;
    f.categories = { mode: "replace", add: [dentist], primary: dentist, additional: [ortho] };
    expect(buildAddCategories(f)).toBeUndefined();
    expect(buildFields(f, nothing)).toEqual({
      categories: { primaryCategory: { name: dentist }, additionalCategories: [{ name: ortho }] },
    });
  });
  it("problems carry the field they belong to, so they show only after it is touched", () => {
    const f = emptyForm();
    f.use.categories = true;
    f.use.serviceItems = true;
    f.services.lines = "Whitening";
    expect(formProblemList(f)).toEqual([
      { key: "categories", message: "Categories: choose at least one category to add" },
      { key: "serviceCategory", message: "Services: choose the category for the new services" },
    ]);
    f.categories.mode = "replace";
    expect(formProblemList(f)[0]).toEqual({ key: "categories", message: "Categories: the primary category is required" });
  });
  it("add-mode services always ask core to skip locations that lack the category; replace never does", () => {
    const f = emptyForm();
    f.use.serviceItems = true;
    f.services = { lines: "Whitening", category: dentist, mode: "add" };
    expect(buildSkipUnoffered(f)).toBe(true);
    f.services.mode = "replace";
    expect(buildSkipUnoffered(f)).toBeUndefined();
    f.services.mode = "add";
    f.use.serviceItems = false;
    expect(buildSkipUnoffered(f)).toBeUndefined();
  });
  it("categoriesAfter reads the resulting list, primary first", () => {
    const after = { primaryCategory: { name: dentist }, additionalCategories: [{ name: ortho }] };
    expect(categoriesAfter([{ field: "title" }, { field: "categories", after }])).toEqual([dentist, ortho]);
    expect(categoriesAfter([{ field: "title" }])).toBeNull();
  });
});
