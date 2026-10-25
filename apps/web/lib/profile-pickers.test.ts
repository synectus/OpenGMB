import { describe, expect, it } from "vitest";
import {
  addAdditional,
  attributeGroups,
  attributeSummary,
  boolChoice,
  boolValue,
  categoryTag,
  changedAttributes,
  choosePrimary,
  localeLine,
  repeatedValue,
  serviceTypesFor,
  socialAttributes,
  uriValue,
  type AttributeMeta,
} from "./profile-pickers";

const meta = (
  name: string,
  group: string,
  valueType: AttributeMeta["valueType"] = "BOOL",
): AttributeMeta => ({
  name: `attributes/${name}`,
  displayName: name.replaceAll("_", " "),
  groupDisplayName: group,
  valueType,
  repeatable: valueType === "REPEATED_ENUM",
  values: [],
});
const METAS = [
  meta("wheelchair_accessible_entrance", "Accessibility"),
  meta("has_wifi", "Amenities"),
  meta("url_facebook", "Social profiles", "URL"),
  meta("url_instagram", "Social profiles", "URL"),
  meta("requires_appointments", "Planning"),
];

describe("categories", () => {
  it("tags the primary and the additional ones", () => {
    const extra = ["categories/gcid:medical_clinic"];
    expect(
      categoryTag(
        "categories/gcid:pain_control_clinic",
        "categories/gcid:pain_control_clinic",
        extra,
      ),
    ).toBe("Primary");
    expect(
      categoryTag("categories/gcid:medical_clinic", "categories/gcid:pain_control_clinic", extra),
    ).toBe("Additional");
    expect(
      categoryTag("categories/gcid:dentist", "categories/gcid:pain_control_clinic", extra),
    ).toBeNull();
  });

  it("choosing an additional category as primary moves it out of the additional list", () => {
    expect(choosePrimary(["categories/gcid:a", "categories/gcid:b"], "categories/gcid:b")).toEqual({
      primary: "categories/gcid:b",
      additional: ["categories/gcid:a"],
    });
  });

  it("adding ignores the primary and duplicates", () => {
    expect(addAdditional("categories/gcid:p", ["categories/gcid:a"], "categories/gcid:p")).toEqual([
      "categories/gcid:a",
    ]);
    expect(addAdditional("categories/gcid:p", ["categories/gcid:a"], "categories/gcid:a")).toEqual([
      "categories/gcid:a",
    ]);
    expect(addAdditional("categories/gcid:p", [], "categories/gcid:b")).toEqual([
      "categories/gcid:b",
    ]);
  });

  it("says which list was searched, in words", () => {
    expect(localeLine("US", "en")).toBe("Google's categories for United States, English.");
    expect(localeLine("AU", "en-AU")).toBe("Google's categories for Australia, English.");
  });
});

describe("attributes", () => {
  it("groups in Google's order, leaves social profiles to their own section, filters by text", () => {
    expect(attributeGroups(METAS, "").map((g) => [g.group, g.items.length])).toEqual([
      ["Accessibility", 1],
      ["Amenities", 1],
      ["Planning", 1],
    ]);
    expect(attributeGroups(METAS, "wifi").map((g) => g.group)).toEqual(["Amenities"]);
    expect(attributeGroups(METAS, "requires_app").map((g) => g.group)).toEqual(["Planning"]);
  });

  it("finds only the social ids Google actually offers", () => {
    expect(socialAttributes(METAS).map((m) => m.name)).toEqual([
      "attributes/url_facebook",
      "attributes/url_instagram",
    ]);
    expect(socialAttributes(METAS.slice(0, 2))).toEqual([]);
  });

  it("Yes / No / Not set round-trips through Google's value shape", () => {
    expect(boolChoice({ values: [true] })).toBe("yes");
    expect(boolChoice({ values: [false] })).toBe("no");
    expect(boolChoice(null)).toBe("unset");
    expect(boolValue("yes")).toEqual({ values: [true] });
    expect(boolValue("unset")).toBeNull();
  });

  it("repeated enums unset only what was set before; URLs clear when empty", () => {
    expect(repeatedValue(["visa"], ["visa", "mastercard"])).toEqual({
      repeatedEnumValue: { setValues: ["visa"], unsetValues: ["mastercard"] },
    });
    expect(repeatedValue([], [])).toBeNull();
    expect(uriValue(" https://facebook.com/x ")).toEqual({
      uriValues: [{ uri: "https://facebook.com/x" }],
    });
    expect(uriValue("")).toBeNull();
  });

  it("counts and sends only the attributes whose value changed", () => {
    const original = {
      "attributes/has_wifi": { values: [true] },
      "attributes/restroom": { values: [true] },
    };
    const now = {
      ...original,
      "attributes/has_wifi": null,
      "attributes/requires_appointments": { values: [true] },
    };
    expect(changedAttributes(original, now)).toEqual({
      "attributes/has_wifi": null,
      "attributes/requires_appointments": { values: [true] },
    });
  });

  it("summarises a value with Google's names", () => {
    const wifi = {
      ...meta("wi_fi", "Amenities", "ENUM"),
      displayName: "Wi-Fi type",
      values: [{ value: "free_wi_fi", displayName: "Free Wi-Fi" }],
    };
    expect(attributeSummary(wifi, { values: ["free_wi_fi"] })).toBe("Wi-Fi type: Free Wi-Fi");
    expect(attributeSummary(METAS[0], { values: [true] })).toBe(
      "wheelchair accessible entrance: Yes",
    );
    expect(
      attributeSummary(
        undefined,
        { uriValues: [{ uri: "https://x.example" }] },
        "attributes/url_menu",
      ),
    ).toBe("Url menu: https://x.example");
  });
});

describe("structured services", () => {
  it("unions service types over the location's categories, first category first", () => {
    expect(
      serviceTypesFor([
        {
          name: "c/a",
          displayName: "A",
          serviceTypes: [
            { serviceTypeId: "s1", displayName: "One" },
            { serviceTypeId: "s2", displayName: "Two" },
          ],
        },
        {
          name: "c/b",
          displayName: "B",
          serviceTypes: [
            { serviceTypeId: "s2", displayName: "Two" },
            { serviceTypeId: "s3", displayName: "Three" },
          ],
        },
      ]).map((s) => s.serviceTypeId),
    ).toEqual(["s1", "s2", "s3"]);
  });
});
