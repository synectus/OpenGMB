import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { snapshotFromGoogle, type GoogleLocation } from "@opengmb/core";
import { buildFields, changedLabels, formFromProfile, previewRows, type ProfileForm } from "./profile-editor";
import type { CategoryMeta } from "./profile-pickers";
import {
  amountToMoney,
  defaultCurrency,
  COMMON_CURRENCIES,
  currencyOptions,
  filterGroups,
  highlightParts,
  groupServices,
  moneyToAmount,
  type ServiceGroup,
} from "./services-manager";

describe("price <-> google.type.Money", () => {
  it("splits decimal text into units and nanos without float rounding", () => {
    expect(amountToMoney("1499.50", "INR")).toEqual({ money: { currencyCode: "INR", units: "1499", nanos: 500_000_000 } });
    expect(amountToMoney("0.99", "USD")).toEqual({ money: { currencyCode: "USD", nanos: 990_000_000 } });
    expect(amountToMoney("100", "USD")).toEqual({ money: { currencyCode: "USD", units: "100" } });
    expect(amountToMoney(" 19.999999999 ", "USD")).toEqual({ money: { currencyCode: "USD", units: "19", nanos: 999_999_999 } });
    expect(amountToMoney("0", "USD")).toEqual({ money: { currencyCode: "USD" } });
  });
  it("an empty amount means no price; bad input is refused", () => {
    expect(amountToMoney("  ", "USD")).toEqual({ money: null });
    for (const bad of ["abc", "-5", "1,000", "1.2345678901", "1."]) expect(amountToMoney(bad, "USD")).toHaveProperty("error");
    expect(amountToMoney("5", "usd")).toHaveProperty("error");
  });
  it("converts back to the text a person types", () => {
    expect(moneyToAmount({ currencyCode: "INR", units: "1499", nanos: 500_000_000 })).toBe("1499.50");
    expect(moneyToAmount({ currencyCode: "USD", nanos: 990_000_000 })).toBe("0.99");
    expect(moneyToAmount({ currencyCode: "USD", units: "100" })).toBe("100");
    expect(moneyToAmount({ currencyCode: "USD", units: "19", nanos: 999_999_999 })).toBe("19.999999999");
    expect(moneyToAmount(undefined)).toBe("");
  });
  it("round-trips", () => {
    for (const a of ["1499.50", "0.99", "100", "0.05", "12.345"]) {
      const r = amountToMoney(a, "USD");
      expect("money" in r && moneyToAmount(r.money)).toBe(a.includes(".") && a.split(".")[1]!.length < 2 ? `${a}0` : a);
    }
  });
  it("defaults to a currency already on the location, else by region, else USD", () => {
    expect(defaultCurrency([undefined, { currencyCode: "EUR", units: "1" }], "IN")).toBe("EUR");
    expect(defaultCurrency([], "IN")).toBe("INR");
    expect(defaultCurrency([], "US")).toBe("USD");
    expect(defaultCurrency([], "ZZ")).toBe("USD");
  });
});

describe("grouping the live location", () => {
  const body = (
    JSON.parse(
      readFileSync(new URL("../../../packages/core/src/google/fixtures/live/location-get-profile.json", import.meta.url), "utf8"),
    ) as { body: GoogleLocation & { categories: { primaryCategory: CategoryMeta; additionalCategories: CategoryMeta[] } } }
  ).body;
  const metaAll = [body.categories.primaryCategory, ...body.categories.additionalCategories].map((c) => ({
    name: c.name,
    displayName: c.displayName,
    serviceTypes: c.serviceTypes ?? [],
  })) as CategoryMeta[];
  const { form, ctx } = formFromProfile({ fields: snapshotFromGoogle(body, null).fields, attributes: {} });
  const arg = (categories: CategoryMeta[], f: ProfileForm = form) => ({
    own: f.own,
    selected: f.structured,
    items: ctx.structured,
    details: f.structuredDetails,
    categories,
    primary: f.primaryCategory,
    additional: f.additionalCategories,
    names: Object.fromEntries(categories.map((c) => [c.name, c.displayName])),
  });
  const total = (g: ServiceGroup[]) => g.reduce((n, x) => n + x.count, 0);

  it("keeps all 268 services, primary first, then profile order, plain names", () => {
    expect(form.own.length + form.structured.length).toBe(268);
    const groups = groupServices(arg(metaAll));
    expect(total(groups)).toBe(268);
    expect(groups.map((g) => g.label).slice(0, 5)).toEqual([
      "Internet marketing service",
      ...body.categories.additionalCategories.map((c) => c.displayName),
    ]);
    expect(groups.some((g) => g.label.includes("gcid"))).toBe(false);
    expect(groups[0]!.count).toBe(48 + groups[0]!.rows.filter((r) => r.kind === "google" && r.selected).length);
  });

  it("with no metadata at all nothing is lost: structured ones fall into Other", () => {
    const groups = groupServices(arg([]));
    expect(total(groups)).toBe(268);
    const other = groups.at(-1)!;
    expect(other.label).toBe("Other");
    expect(other.rows.filter((r) => r.kind === "google")).toHaveLength(form.structured.length);
    expect(groups[0]!.label).toBe("Internet marketing service");
  });

  it("a structured service no loaded category offers goes to Other, the rest stay grouped", () => {
    const trimmed = metaAll.map((c) => ({ ...c, serviceTypes: c.serviceTypes.filter((s) => s.serviceTypeId !== "job_type_id:branding") }));
    const groups = groupServices(arg(trimmed));
    expect(total(groups)).toBe(268);
    expect(groups.at(-1)!.rows.map((r) => r.name)).toEqual(["Branding"]);
  });

  it("an own service in a category not on the profile goes to Other", () => {
    const f = { ...form, own: [...form.own, { name: "Elsewhere", description: "", category: "categories/gcid:florist" }] };
    const groups = groupServices(arg(metaAll, f));
    expect(total(groups)).toBe(269);
    expect(groups.at(-1)!.rows.map((r) => r.name)).toEqual(["Elsewhere"]);
  });

  it("a service type two categories offer is listed once", () => {
    const ids = groupServices(arg(metaAll)).flatMap((g) => g.rows.flatMap((r) => (r.kind === "google" ? [r.id] : [])));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("an empty primary group still exists so a service can be added to it", () => {
    const groups = groupServices({ ...arg([]), names: {}, own: [], selected: [] });
    expect(groups.map((g) => [g.label, g.count])).toEqual([
      ["Internet marketing service", 0],
      ["Back office", 0],
      ["Software company", 0],
      ["Website designer", 0],
      ["Marketing consultant", 0],
    ]);
  });
});

describe("search", () => {
  const groups = groupServices({
    own: [
      { name: "Logo design", description: "Brand marks", category: "categories/gcid:a" },
      { name: "Audit", description: "Technical SEO audit", category: "categories/gcid:b" },
    ],
    selected: [],
    items: [],
    details: {},
    categories: [{ name: "categories/gcid:a", displayName: "A", serviceTypes: [{ serviceTypeId: "job_type_id:logo", displayName: "Logo printing" }] }],
    primary: "categories/gcid:a",
    additional: ["categories/gcid:b"],
    names: { "categories/gcid:a": "A", "categories/gcid:b": "B" },
  });
  it("empty query returns everything", () => {
    expect(filterGroups(groups, "  ").groups).toBe(groups);
    expect(filterGroups(groups, "").matches).toBe(3);
  });
  it("matches name or description, any case, across groups, and hides empty groups", () => {
    const logo = filterGroups(groups, "LOGO");
    expect(logo.matches).toBe(2);
    expect(logo.groups.map((g) => g.label)).toEqual(["A"]);
    const seo = filterGroups(groups, "seo");
    expect(seo.matches).toBe(1);
    expect(seo.groups.map((g) => g.label)).toEqual(["B"]);
    expect(filterGroups(groups, "zzz")).toEqual({ groups: [], matches: 0 });
  });
});

describe("edits in the panel reach the preview fields", () => {
  const fields = {
    categories: { primaryCategory: { name: "categories/gcid:a" } },
    serviceItems: [
      { structuredServiceItem: { serviceTypeId: "job_type_id:x", description: "Old" } },
      { freeFormServiceItem: { category: "categories/gcid:a", label: { displayName: "Own", description: "Old own" } } },
    ],
  };
  const { form, ctx } = formFromProfile({ fields, attributes: {} });
  const sent = (now: ProfileForm) => buildFields(form, now, ctx).serviceItems;
  it("no edit, no change", () => expect(changedLabels(form, form, ctx)).toEqual([]));
  it("an own service description or price is a Services change", () => {
    const money = (amountToMoney("1499.50", "INR") as { money: object }).money;
    expect(sent({ ...form, own: [{ ...form.own[0]!, description: "New own" }] })).toMatchObject([
      { structuredServiceItem: { description: "Old" } },
      { freeFormServiceItem: { label: { description: "New own" } } },
    ]);
    expect(sent({ ...form, own: [{ ...form.own[0]!, price: money }] })).toMatchObject([
      {},
      { price: { currencyCode: "INR", units: "1499", nanos: 500_000_000 } },
    ]);
  });
  it("a Google-list service description, price and clearing", () => {
    const x = "job_type_id:x";
    expect(sent({ ...form, structuredDetails: { [x]: { description: " New " } } })).toMatchObject([
      { structuredServiceItem: { serviceTypeId: x, description: "New" } },
      {},
    ]);
    expect(sent({ ...form, structuredDetails: { [x]: { price: { currencyCode: "USD", units: "5" } } } })).toMatchObject([
      { structuredServiceItem: { description: "Old" }, price: { units: "5" } },
      {},
    ]);
    const cleared = sent({ ...form, structuredDetails: { [x]: { description: "" } } }) as { structuredServiceItem: object }[];
    expect(cleared[0]!.structuredServiceItem).toEqual({ serviceTypeId: x });
  });
  it("an edit then undone is no change", () => {
    const undone = { ...form, structuredDetails: { "job_type_id:x": { description: "Old", price: null } } };
    expect(changedLabels(form, undone, ctx)).toEqual([]);
  });
});

describe("the preview lists a changed service", () => {
  const svc = (name: string, extra: object = {}) => ({
    freeFormServiceItem: { category: "categories/gcid:a", label: { displayName: name } },
    ...extra,
  });
  const rows = (before: object[], after: object[]) =>
    previewRows([{ field: "serviceItems", before, after }], { "categories/gcid:a": "Alpha" });
  it("shows a price-only change, with unchanged services left out", () => {
    const out = rows([svc("Cut"), svc("Dye")], [svc("Cut", { price: { currencyCode: "USD", units: "12", nanos: 500_000_000 } }), svc("Dye")]);
    expect(out).toEqual([{ field: "Services", now: "Cut (Alpha)", next: "Cut (Alpha) · USD 12.50" }]);
  });
  it("shows a description change, an added and a removed service", () => {
    const withText = { freeFormServiceItem: { category: "categories/gcid:a", label: { displayName: "Cut", description: "Fast" } } };
    expect(rows([svc("Cut")], [withText])[0]!.next).toBe("Cut (Alpha) · Fast");
    expect(rows([svc("Cut")], [svc("Cut"), svc("Dye")])).toEqual([{ field: "Services", now: "Not set", next: "Dye (Alpha)" }]);
    expect(rows([svc("Cut"), svc("Dye")], [svc("Cut")])).toEqual([{ field: "Services", now: "Dye (Alpha)", next: "Not set" }]);
  });
  it("no row when nothing differs", () => expect(rows([svc("Cut")], [svc("Cut")])).toEqual([]));
});

describe("moving and removing a service", () => {
  const A = "categories/gcid:a";
  const B = "categories/gcid:b";
  const fields = {
    categories: { primaryCategory: { name: A }, additionalCategories: [{ name: B }] },
    serviceItems: [
      { structuredServiceItem: { serviceTypeId: "job_type_id:x" } },
      { freeFormServiceItem: { category: A, label: { displayName: "Own" } } },
    ],
  };
  const { form, ctx } = formFromProfile({ fields, attributes: {} });
  const meta: CategoryMeta[] = [{ name: A, displayName: "A", serviceTypes: [{ serviceTypeId: "job_type_id:x", displayName: "X" }] }];
  const grouped = (f: ProfileForm) =>
    groupServices({
      own: f.own,
      selected: f.structured,
      items: ctx.structured,
      details: f.structuredDetails,
      categories: meta,
      primary: f.primaryCategory,
      additional: f.additionalCategories,
      names: { [A]: "A", [B]: "B" },
    });
  const counts = (f: ProfileForm) => grouped(f).map((g) => [g.label, g.count]);

  it("changing an own service's category moves it and keeps its other fields; the category is sent", () => {
    const now = { ...form, own: [{ ...form.own[0]!, category: B }] };
    expect(counts(form)).toEqual([["A", 2], ["B", 0]]);
    expect(counts(now)).toEqual([["A", 1], ["B", 1]]);
    expect(buildFields(form, now, ctx).serviceItems).toMatchObject([{}, { freeFormServiceItem: { category: B, label: { displayName: "Own" } } }]);
  });
  it("removing an own service drops only it", () => {
    const now = { ...form, own: [] };
    expect(counts(now)).toEqual([["A", 1], ["B", 0]]);
    expect(buildFields(form, now, ctx).serviceItems).toEqual([{ structuredServiceItem: { serviceTypeId: "job_type_id:x" } }]);
  });
  it("unticking a Google-list service drops only it, and it stays listed to tick again", () => {
    const now = { ...form, structured: [] };
    expect(counts(now)).toEqual([["A", 1], ["B", 0]]);
    expect(grouped(now)[0]!.rows.some((r) => r.kind === "google" && r.id === "job_type_id:x" && !r.selected)).toBe(true);
    expect(buildFields(form, now, ctx).serviceItems).toMatchObject([{ freeFormServiceItem: { label: { displayName: "Own" } } }]);
  });
});

describe("search counts, highlight and currency list", () => {
  const row = (name: string, description = "") => ({ kind: "google" as const, id: name, name, description, selected: false });
  const groups: ServiceGroup[] = [
    { key: "a", label: "A", count: 0, rows: [row("SEO audit"), row("Branding"), row("Local seo", "x")] },
    { key: "b", label: "B", count: 0, rows: [row("Billboards"), row("Copy", "all about SEO")] },
    { key: "c", label: "C", count: 0, rows: [row("Nothing")] },
  ];

  it("reports matched rows and the group's total, so a header can read 'N of M'", () => {
    const r = filterGroups(groups, " seo ");
    expect(r.groups.map((g) => [g.key, g.rows.length, g.of])).toEqual([["a", 2, 3], ["b", 1, 2]]);
    expect(r.matches).toBe(3);
  });

  it("without a query every group shows all its rows", () => {
    const r = filterGroups(groups, "");
    expect(r.groups.map((g) => g.rows.length)).toEqual([3, 2, 1]);
    expect(r.matches).toBe(6);
  });

  it("splits text around every case-insensitive match and keeps the original casing", () => {
    expect(highlightParts("SEO for seo fans", "Seo")).toEqual([
      { text: "SEO", match: true },
      { text: " for ", match: false },
      { text: "seo", match: true },
      { text: " fans", match: false },
    ]);
    expect(highlightParts("abc", "")).toEqual([{ text: "abc", match: false }]);
    expect(highlightParts("abc", "zz")).toEqual([{ text: "abc", match: false }]);
    expect(highlightParts("", "a")).toEqual([{ text: "", match: false }]);
  });

  it("lists the common currencies first in their fixed order, then the rest sorted without repeats", () => {
    const out = currencyOptions(["ZAR", "USD", "AED", "INR", "JPY", "AED"]);
    expect(out.slice(0, 7)).toEqual(["INR", "USD", "AUD", "GBP", "CAD", "NZD", "EUR"]);
    expect(out.slice(7)).toEqual(["AED", "JPY", "ZAR"]);
    expect(new Set(out).size).toBe(out.length);
  });

  it("falls back to the common list, and keeps a code already on the price", () => {
    expect(currencyOptions(undefined)).toEqual(COMMON_CURRENCIES);
    expect(currencyOptions(undefined, "CHF")).toEqual([...COMMON_CURRENCIES, "CHF"]);
    expect(currencyOptions(["CHF"], "USD")).toEqual([...COMMON_CURRENCIES, "CHF"]);
  });
});
