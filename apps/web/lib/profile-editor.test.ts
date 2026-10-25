import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NORMALISE, snapshotFromGoogle, type GoogleLocation } from "@opengmb/core";
import {
  addPlace,
  addressProblem,
  buildFields,
  changeSummary,
  changedLabels,
  copyMondayToWeekdays,
  formFromProfile,
  gridFromHours,
  hoursFromGrid,
  linkFailure,
  placeActionLabel,
  previewRows,
  serviceChangeCards,
  proposeState,
  reasonText,
  setDayOpen,
  servicesFrom,
  structuredItems,
  type ProfileForm,
} from "./profile-editor";

const t = (hours: number, minutes = 0) => ({ hours, minutes });
const period = (day: string, o: number, c: number, closeDay = day) => ({
  openDay: day,
  openTime: t(o),
  closeDay,
  closeTime: t(c),
});

const PROFILE = {
  fields: {
    title: "Rivermoor Pain Clinic",
    description: "We treat back pain.",
    categories: {
      primaryCategory: { name: "categories/gcid:pain_control_clinic" },
      additionalCategories: [{ name: "categories/gcid:medical_clinic" }],
    },
    regularHours: {
      periods: [
        period("MONDAY", 8, 18),
        period("TUESDAY", 8, 12),
        period("TUESDAY", 13, 18),
        period("SATURDAY", 9, 13),
      ],
    },
    specialHours: null,
    serviceItems: [
      { structuredServiceItem: { serviceTypeId: "job_type_id:pain_consult" } },
      {
        freeFormServiceItem: {
          category: "categories/gcid:pain_control_clinic",
          label: {
            displayName: "Same-week appointments",
            description: "Most new patients are seen within the week.",
          },
        },
      },
    ],
    serviceArea: null,
    websiteUri: "https://rivermoorpainclinic.example",
    openingDate: { year: 2016, month: 4, day: 1 },
    phoneNumbers: { primaryPhone: "+1 956 555 0142", additionalPhones: [] },
  },
  attributes: { "attributes/has_wifi": { values: [true] } },
};
const start = () => formFromProfile(PROFILE);
function edit(patch: Partial<ProfileForm>) {
  const { form, ctx } = start();
  return { initial: form, now: { ...form, ...patch }, ctx };
}

describe("regular hours grid", () => {
  it("reads one row per day: split days as two spans, other days closed", () => {
    const { rows, kept } = gridFromHours(PROFILE.fields.regularHours);
    expect(rows.map((r) => [r.day, r.open, r.spans.map((s) => `${s.from}-${s.to}`)])).toEqual([
      ["MONDAY", true, ["08:00-18:00"]],
      ["TUESDAY", true, ["08:00-12:00", "13:00-18:00"]],
      ["WEDNESDAY", false, []],
      ["THURSDAY", false, []],
      ["FRIDAY", false, []],
      ["SATURDAY", true, ["09:00-13:00"]],
      ["SUNDAY", false, []],
    ]);
    expect(kept).toEqual([]);
  });

  it("round-trips same-day periods, including open 24 hours as 00:00 to 24:00", () => {
    const hours = { periods: [period("MONDAY", 8, 18), period("THURSDAY", 0, 24)] };
    const { rows, kept } = gridFromHours(hours);
    expect(hoursFromGrid(rows, kept)).toEqual(hours);
  });

  it("keeps a period that closes on another day as it is and sends it back", () => {
    const overnight = period("FRIDAY", 20, 2, "SATURDAY");
    const { rows, kept } = gridFromHours({ periods: [period("MONDAY", 8, 18), overnight] });
    expect(kept).toEqual([overnight]);
    expect(rows.find((r) => r.day === "FRIDAY")!.open).toBe(false);
    expect(hoursFromGrid(rows, kept)!.periods).toContainEqual(overnight);
  });

  it("no open day and nothing kept clears the hours", () => {
    expect(hoursFromGrid(gridFromHours(null).rows, [])).toBeNull();
  });

  it("opening a day adds 09:00 to 17:00; Copy Monday fills Tuesday to Friday only", () => {
    const { rows } = gridFromHours(PROFILE.fields.regularHours);
    expect(setDayOpen(rows, "WEDNESDAY", true).find((r) => r.day === "WEDNESDAY")!.spans).toEqual([
      { from: "09:00", to: "17:00" },
    ]);
    const copied = copyMondayToWeekdays(rows);
    for (const d of ["TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"]) {
      expect(copied.find((r) => r.day === d)).toMatchObject({
        open: true,
        spans: [{ from: "08:00", to: "18:00" }],
      });
    }
    expect(copied.find((r) => r.day === "SATURDAY")).toEqual(rows.find((r) => r.day === "SATURDAY"));
  });
});

describe("what changed and what is sent", () => {
  it("nothing edited: no labels, 'No changes yet', no fields", () => {
    const { form, ctx } = start();
    expect(changedLabels(form, form, ctx)).toEqual([]);
    expect(changeSummary([])).toBe("No changes yet");
    expect(buildFields(form, form, ctx)).toEqual({});
  });

  it("opening a closed day and closing it again is not a change", () => {
    const { form, ctx } = start();
    const back = setDayOpen(setDayOpen(form.hours, "SUNDAY", true), "SUNDAY", false);
    expect(changedLabels(form, { ...form, hours: back }, ctx)).toEqual([]);
  });

  it("names the changed fields in a fixed order and sends only those", () => {
    const { form, ctx } = start();
    const now: ProfileForm = {
      ...form,
      description: "We treat back and joint pain.",
      hours: setDayOpen(form.hours, "SATURDAY", false),
      additionalCategories: [...form.additionalCategories, "categories/gcid:physical_therapy_clinic"],
    };
    const labels = changedLabels(form, now, ctx);
    expect(labels).toEqual(["Description", "Additional categories", "Regular hours"]);
    expect(changeSummary(labels)).toBe(
      "3 fields changed: Description, Additional categories, Regular hours",
    );
    const sent = buildFields(form, now, ctx);
    expect(Object.keys(sent).sort()).toEqual(["categories", "description", "regularHours"]);
    expect(sent.categories).toEqual({
      primaryCategory: { name: "categories/gcid:pain_control_clinic" },
      additionalCategories: [
        { name: "categories/gcid:medical_clinic" },
        { name: "categories/gcid:physical_therapy_clinic" },
      ],
    });
    expect(
      (sent.regularHours as { periods: { openDay: string }[] }).periods.map((p) => p.openDay),
    ).toEqual(["MONDAY", "TUESDAY", "TUESDAY"]);
  });

  it("one change reads '1 field changed'", () => {
    expect(changeSummary(["Website"])).toBe("1 field changed: Website");
  });

  it("phones go together; an emptied primary phone is sent so the guardrail can block it", () => {
    const { initial, now, ctx } = edit({ phone: "" });
    expect(buildFields(initial, now, ctx).phoneNumbers).toEqual({
      primaryPhone: "",
      additionalPhones: [],
    });
  });

  it("editing own services keeps Google's structured services untouched", () => {
    const { initial, now, ctx } = edit({ own: [{ name: "Spanish-speaking staff", description: "" }] });
    expect(buildFields(initial, now, ctx).serviceItems).toEqual([
      { structuredServiceItem: { serviceTypeId: "job_type_id:pain_consult" } },
      {
        freeFormServiceItem: {
          category: "categories/gcid:pain_control_clinic",
          label: { displayName: "Spanish-speaking staff" },
        },
      },
    ]);
  });

  it("website and opening date can be cleared", () => {
    const { initial, now, ctx } = edit({ website: " ", opening: "" });
    expect(buildFields(initial, now, ctx)).toEqual({ websiteUri: null, openingDate: null });
  });

  it("only attributes whose value changed are sent; null deletes", () => {
    const { form, ctx } = start();
    const attributes = { ...form.attributes, "attributes/has_wifi": null, "attributes/restroom": { values: [true] } };
    expect(buildFields(form, { ...form, attributes }, ctx)).toEqual({
      attributes: { "attributes/has_wifi": null, "attributes/restroom": { values: [true] } },
    });
  });

  it("unticking a structured service drops it; ticking a new one adds it", () => {
    const { initial, now, ctx } = edit({ structured: ["job_type_id:injury_rehabilitation"] });
    expect(buildFields(initial, now, ctx).serviceItems).toEqual([
      { structuredServiceItem: { serviceTypeId: "job_type_id:injury_rehabilitation" } },
      {
        freeFormServiceItem: {
          category: "categories/gcid:pain_control_clinic",
          label: { displayName: "Same-week appointments", description: "Most new patients are seen within the week." },
        },
      },
    ]);
  });
});

describe("service area", () => {
  const area = { type: "CUSTOMER_AND_BUSINESS_LOCATION" as const, places: [] };
  const ID = "ChIJk3n0ARMhYYYRXyC2gZl6PRk";

  it("adds a pasted place id with its name, trimmed", () => {
    expect(addPlace(area, " Rivermoor, TX ", ` ${ID} `, 20)).toEqual({
      area: { ...area, places: [{ placeName: "Rivermoor, TX", placeId: ID }] },
    });
  });

  it("refuses a missing name, a malformed id, a duplicate and more than the limit", () => {
    expect(addPlace(area, "", ID, 20)).toHaveProperty("error");
    expect(addPlace(area, "Rivermoor", "not a place id!", 20)).toHaveProperty("error");
    const one = { ...area, places: [{ placeName: "Rivermoor, TX", placeId: ID }] };
    expect(addPlace(one, "Rivermoor", ID, 20)).toHaveProperty("error");
    expect(addPlace(one, "Rio Bravo, TX", "ChIJ0000000000000000000000", 1)).toEqual({
      error: "INVALID_INPUT: At most 1 places.",
    });
  });

  it("choosing a type sends the area with its places", () => {
    const { initial, now, ctx } = edit({ area: { type: "CUSTOMER_LOCATION_ONLY", places: [] } });
    expect(buildFields(initial, now, ctx)).toEqual({
      serviceArea: { businessType: "CUSTOMER_LOCATION_ONLY", places: { placeInfos: [] } },
    });
  });
});

describe("when Propose is allowed", () => {
  const clean = { noChange: false, error: null, guardrail: { ok: true, violations: [] } };
  const p = (over: Partial<Parameters<typeof proposeState>[0]> = {}) =>
    proposeState({ preview: clean, previewKey: "k", currentKey: "k", acknowledged: false, ...over });

  it("needs a preview of exactly the current edit", () => {
    expect(p({ preview: null, previewKey: null })).toEqual({ kind: "disabled", note: "Preview first" });
    expect(p({ currentKey: "k2" })).toEqual({
      kind: "disabled",
      note: "Changed since the preview. Preview again.",
    });
    expect(p()).toEqual({ kind: "ready", note: null });
  });

  it("a read error or no change disables it", () => {
    expect(p({ preview: { ...clean, error: "google_http_500" } }).kind).toBe("disabled");
    expect(p({ preview: { ...clean, noChange: true } })).toEqual({
      kind: "disabled",
      note: "No change: these values already match Google.",
    });
  });

  it("a block hides it; a warning needs the box ticked", () => {
    const blocked = { ...clean, guardrail: { ok: false, violations: [{ severity: "block" as const }] } };
    expect(p({ preview: blocked })).toEqual({ kind: "hidden", note: "Fix these to propose." });
    const warned = { ...clean, guardrail: { ok: true, violations: [{ severity: "warn" as const }] } };
    expect(p({ preview: warned })).toEqual({
      kind: "disabled",
      note: "Acknowledge the warnings to propose.",
    });
    expect(p({ preview: warned, acknowledged: true })).toEqual({ kind: "ready", note: null });
  });
});

describe("preview rows", () => {
  it("splits hours by day, names categories, labels attributes", () => {
    const rows = previewRows(
      [
        {
          field: "regularHours",
          before: { periods: [period("MONDAY", 8, 18), period("SATURDAY", 9, 13)] },
          after: { periods: [period("MONDAY", 8, 18)] },
        },
        {
          field: "categories",
          before: {
            primaryCategory: { name: "categories/gcid:pain_control_clinic" },
            additionalCategories: [{ name: "categories/gcid:medical_clinic" }],
          },
          after: {
            primaryCategory: { name: "categories/gcid:pain_control_clinic" },
            additionalCategories: [
              { name: "categories/gcid:medical_clinic" },
              { name: "categories/gcid:physical_therapy_clinic" },
            ],
          },
        },
        { field: "description", before: null, after: "We treat back pain." },
        { field: "attributes/has_wifi", before: { values: [true] }, after: null },
      ],
      {
        "categories/gcid:pain_control_clinic": "Pain control clinic",
        "categories/gcid:medical_clinic": "Medical clinic",
      },
    );
    expect(rows).toEqual([
      { field: "Saturday hours", now: "09:00 to 13:00", next: "Closed" },
      {
        field: "Additional categories",
        now: "Medical clinic",
        next: "Medical clinic, Physical therapy clinic",
      },
      { field: "Description", now: "Not set", next: "We treat back pain." },
      { field: "Attribute: Has wifi", now: "Yes", next: "Not set" },
    ]);
  });
});

describe("reason and link texts", () => {
  it("labels known reason codes and leaves others as they are", () => {
    expect(reasonText("conflict")).toBe("Changed on Google since the preview; nothing was written.");
    expect(reasonText("google_writes_disabled")).toBe("Google writes are turned off on this server.");
    expect(reasonText("google_http_400")).toBe("Google http 400");
  });

  it("names place action types and link failures", () => {
    expect(placeActionLabel("ONLINE_APPOINTMENT")).toBe("Online appointment");
    expect(linkFailure("google_writes_disabled")).toBe(
      "Google writes are turned off on this server.",
    );
    expect(linkFailure("google_http_400")).toBe("Google did not accept it (google http 400)");
  });
});

describe("services survive a profile -> form -> fields round trip", () => {
  const FIXTURES = "../../../packages/core/src/google/fixtures";
  const load = (path: string) =>
    (JSON.parse(readFileSync(new URL(`${FIXTURES}/${path}`, import.meta.url), "utf8")) as {
      body: GoogleLocation;
    }).body;
  type Item = {
    freeFormServiceItem?: { category: string; label: { displayName: string } };
    structuredServiceItem?: { serviceTypeId: string; description?: string };
    price?: unknown;
  };
  const norm = (v: unknown) => NORMALISE.serviceItems(v) as Item[];
  const cat = (i: Item) => i.freeFormServiceItem?.category as string | undefined;

  const cases = [
    { name: "live profile (268 items, 5 categories, structured descriptions)", file: "live/location-get-profile.json", min: 268, categories: 5, priced: 0 },
    { name: "synthetic priced services", file: "synthetic/services-priced.json", min: 5, categories: 2, priced: 3 },
  ];

  for (const c of cases) {
    it(`${c.name}: every item comes back, with its category, description and price`, () => {
      const loc = load(c.file);
      const input = norm(loc.serviceItems);
      // The fixture must contain what the test claims to cover.
      expect(input.length).toBeGreaterThanOrEqual(c.min);
      expect(new Set(input.map(cat).filter(Boolean)).size).toBe(c.categories);
      expect(input.filter((i) => i.price).length).toBe(c.priced);
      expect(input.filter((i) => i.structuredServiceItem?.description).length).toBeGreaterThan(0);

      const profile = { fields: snapshotFromGoogle(loc, null).fields, attributes: {} };
      const { form, ctx } = formFromProfile(profile);

      // Untouched: the form rebuilds the same list.
      const rebuilt = norm(servicesFrom(form.own, structuredItems(form.structured, ctx.structured), ctx.serviceCategory));
      expect(rebuilt.length).toBe(input.length);
      expect(rebuilt).toEqual(input);

      // Adding one service writes everything else back exactly; the new one takes the primary category.
      const now = { ...form, own: [...form.own, { name: "Brand new", description: "" }] };
      const sent = buildFields(form, now, ctx).serviceItems as unknown[];
      const out = norm(sent);
      expect(out.length).toBe(input.length + 1);
      const added = out.filter((i) => i.freeFormServiceItem?.label.displayName === "Brand new");
      expect(added).toHaveLength(1);
      expect(cat(added[0]!)).toBe(ctx.serviceCategory);
      expect(out.filter((i) => i !== added[0])).toEqual(input);
    });
  }

  it("renaming a priced service keeps its price and category; unticking a structured one drops only it", () => {
    const loc = load("synthetic/services-priced.json");
    const { form, ctx } = formFromProfile({ fields: snapshotFromGoogle(loc, null).fields, attributes: {} });
    const veneers = form.own.findIndex((o) => o.name === "Veneers");
    const own = form.own.map((o, i) => (i === veneers ? { ...o, name: "Porcelain veneers" } : o));
    const structured = form.structured.filter((id) => id !== "job_type_id:cleaning");
    const out = norm(buildFields(form, { ...form, own, structured }, ctx).serviceItems);
    expect(out).toHaveLength(4);
    expect(out.find((i) => i.freeFormServiceItem?.label.displayName === "Porcelain veneers")).toEqual({
      freeFormServiceItem: { category: "categories/gcid:cosmetic_dentist", label: { displayName: "Porcelain veneers" } },
      price: { currencyCode: "USD", units: "1200" },
    });
    expect(out.find((i) => i.structuredServiceItem?.serviceTypeId === "job_type_id:teeth_whitening")).toMatchObject({
      structuredServiceItem: { description: "In-chair whitening." },
      price: { currencyCode: "USD", units: "299" },
    });
    expect(out.some((i) => i.structuredServiceItem?.serviceTypeId === "job_type_id:cleaning")).toBe(false);
  });
});

describe("serviceChangeCards", () => {
  const cat = (n: string) => n.replace("categories/", "");
  const free = (name: string, units?: string, description?: string) => ({
    freeFormServiceItem: { category: "categories/dentist", label: { displayName: name, ...(description ? { description } : {}) } },
    ...(units ? { price: { currencyCode: "USD", units } } : {}),
  });
  it("lists only changed services with before and after, and null for an added or removed one", () => {
    const before = [free("Same", "5"), free("Whitening", "100", "Old"), free("Gone")];
    const after = [free("Same", "5"), free("Whitening", "150", "Old"), free("Fresh", "9")];
    const cards = serviceChangeCards(before, after, cat);
    expect(cards.map((c) => c.name)).toEqual(["Whitening", "Gone", "Fresh"]);
    expect(cards[0]).toEqual({
      name: "Whitening",
      category: "dentist",
      before: { price: "USD 100", description: "Old" },
      after: { price: "USD 150", description: "Old" },
    });
    expect(cards[1]!.after).toBeNull();
    expect(cards[2]!.before).toBeNull();
  });
});

describe("address and store code (L5)", () => {
  const withAddress = {
    ...PROFILE,
    fields: {
      ...PROFILE.fields,
      storeCode: "LPC-001",
      storefrontAddress: {
        regionCode: "US",
        postalCode: "75940",
        administrativeArea: "TX",
        locality: "Rivermoor",
        addressLines: ["100 Main St", "Suite 4"],
      },
    },
  };

  it("reads Google's address into boxes; an untouched form sends nothing", () => {
    const { form, ctx } = formFromProfile(withAddress);
    expect(form.storeCode).toBe("LPC-001");
    expect(form.address).toEqual({ country: "US", lines: "100 Main St\nSuite 4", city: "Rivermoor", region: "TX", postal: "75940" });
    expect(buildFields(form, form, ctx)).toEqual({});
  });

  it("an edited street line sends the whole address; a new store code sends it; an emptied one sends null", () => {
    const { form, ctx } = formFromProfile(withAddress);
    const moved = { ...form, address: { ...form.address, lines: "200 Elm St" } };
    expect(buildFields(form, moved, ctx)).toEqual({
      storefrontAddress: { regionCode: "US", postalCode: "75940", administrativeArea: "TX", locality: "Rivermoor", addressLines: ["200 Elm St"] },
    });
    expect(changedLabels(form, moved, ctx)).toEqual(["Address"]);
    expect(buildFields(form, { ...form, storeCode: " LPC-002 " }, ctx)).toEqual({ storeCode: "LPC-002" });
    expect(buildFields(form, { ...form, storeCode: "" }, ctx)).toEqual({ storeCode: null });
  });

  it("a location without an address starts with the region as country and sends nothing until a line or city is typed", () => {
    const { form, ctx } = formFromProfile(PROFILE, "IN");
    expect(form.address.country).toBe("IN");
    expect(buildFields(form, { ...form }, ctx)).toEqual({});
    const typed = { ...form, address: { ...form.address, city: "Bhopal" } };
    expect(buildFields(form, typed, ctx)).toEqual({ storefrontAddress: { regionCode: "IN", locality: "Bhopal" } });
  });

  it("problems are said in plain words; emptying the address is not sent", () => {
    const base = { country: "US", lines: "", city: "", region: "", postal: "" };
    expect(addressProblem(base)).toBeNull();
    expect(addressProblem({ ...base, postal: "75940" })).toBe("Add a street line or a city.");
    expect(addressProblem({ ...base, city: "Rivermoor", country: "USA" })).toMatch(/two-letter/);
    expect(addressProblem({ ...base, lines: "1\n2\n3\n4\n5\n6" })).toMatch(/at most 5/);
    const { form, ctx } = formFromProfile(withAddress);
    const emptied = { ...form, address: { country: "US", lines: "", city: "", region: "", postal: "" } };
    expect(buildFields(form, emptied, ctx)).toEqual({});
  });

  it("preview rows show the address as one line and the store code by name", () => {
    const rows = previewRows(
      [
        { field: "storeCode", before: null, after: "LPC-002" },
        { field: "storefrontAddress", before: withAddress.fields.storefrontAddress, after: { regionCode: "US", locality: "Austin" } },
      ],
      {},
    );
    expect(rows).toEqual([
      { field: "Store code", now: "Not set", next: "LPC-002" },
      {
        field: "Address",
        now: "Street: 100 Main St, Suite 4\nState or region: TX\nCity: Rivermoor\nPostal code: 75940",
        next: "Street: Not set\nState or region: Not set\nCity: Austin\nPostal code: Not set",
      },
    ]);
  });

  it("parts the form does not show travel back unchanged, and the preview lists only the parts that changed", () => {
    const rich = {
      ...withAddress,
      fields: {
        ...withAddress.fields,
        storefrontAddress: { ...withAddress.fields.storefrontAddress, sublocality: "Downtown", languageCode: "en", organization: "Clinic" },
      },
    };
    const { form, ctx } = formFromProfile(rich);
    expect(buildFields(form, form, ctx)).toEqual({});
    const sent = buildFields(form, { ...form, address: { ...form.address, lines: "200 Elm St" } }, ctx);
    expect(sent.storefrontAddress).toEqual({
      regionCode: "US", postalCode: "75940", administrativeArea: "TX", locality: "Rivermoor",
      addressLines: ["200 Elm St"], sublocality: "Downtown", languageCode: "en", organization: "Clinic",
    });
    expect(
      previewRows([{ field: "storefrontAddress", before: rich.fields.storefrontAddress, after: sent.storefrontAddress }], {}),
    ).toEqual([{ field: "Address", now: "Street: 100 Main St, Suite 4", next: "Street: 200 Elm St" }]);
  });
});
