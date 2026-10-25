import { describe, expect, it } from "vitest";
import { cityFromAddress, resolveVariables, type LocationVars } from "./variables";

const vars: LocationVars = {
  name: "Acme Dental Austin",
  city: "Austin",
  phone: "+1 555 010 0199",
  address: "1 Main St, Austin, TX 78701, US",
  website: null,
};

describe("resolveVariables", () => {
  it("fills known variables, any case, with optional spaces", () => {
    const r = resolveVariables("Visit {name} in {City}. Call {  phone }.", vars);
    expect(r.text).toBe("Visit Acme Dental Austin in Austin. Call +1 555 010 0199.");
    expect(r.errors).toEqual([]);
  });
  it("reports an unknown variable and names the ones that exist", () => {
    const r = resolveVariables("Hi {nme}", vars);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("{nme}");
    expect(r.errors[0]).toContain("{city}");
  });
  it("reports a known variable with no value instead of leaving it blank", () => {
    const r = resolveVariables("See {website}", vars);
    expect(r.errors).toEqual(["{website} has no value for Acme Dental Austin"]);
    expect(r.text).toContain("{website}");
  });
  it("leaves text without variables alone, including lone braces", () => {
    expect(resolveVariables("50% off {} and { 5 } and {a b}", vars)).toEqual({ text: "50% off {} and { 5 } and {a b}", errors: [] });
  });
  it("reports each problem variable once", () => {
    expect(resolveVariables("{x} {x} {website} {website}", vars).errors).toHaveLength(2);
  });
});

describe("cityFromAddress", () => {
  it.each([
    ["1 Main St, Austin, TX 78701, US", "Austin"],
    ["1 Main St, Suite 4, Austin, TX 78701", "Austin"],
    ["Austin, TX 78701, US", "Austin"],
    ["12 George St, Sydney, NSW 2000, AU", "Sydney"],
    ["Austin", null],
    ["Austin, US", null],
    ["", null],
    [null, null],
  ])("%s -> %s", (input, want) => {
    expect(cityFromAddress(input)).toBe(want);
  });
});
