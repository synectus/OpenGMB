import { describe, expect, it } from "vitest";
import { allRules } from "../../../packages/core/src/guardrails";
import {
  GUARDRAIL_RULE_IDS,
  UNKNOWN_DATE,
  attributeLabel,
  categoryLabel,
  enumLabel,
  guardrailLabel,
  humanise,
  isMissingTimestamp,
  statusLabel,
} from "./labels";

describe("humanise", () => {
  it("turns ids into sentence case words", () => {
    expect(humanise("internet_marketing_service")).toBe("Internet marketing service");
    expect(humanise("categories/gcid:web_designer")).toBe("Web designer");
    expect(humanise("attributes/has_onsite_parking")).toBe("Has onsite parking");
    expect(humanise("AT_WORK")).toBe("At work");
    expect(humanise("hasWifi")).toBe("Has wifi");
  });
});

describe("categoryLabel", () => {
  it("prefers the loaded displayName, with or without the categories/ prefix", () => {
    expect(categoryLabel("categories/gcid:dentist", { "categories/gcid:dentist": "Dentist" })).toBe("Dentist");
    expect(categoryLabel("gcid:dentist", { "categories/gcid:dentist": "Dentist" })).toBe("Dentist");
  });
  it("falls back to words, never the raw id", () => {
    expect(categoryLabel("categories/gcid:internet_marketing_service")).toBe("Internet marketing service");
    expect(categoryLabel("categories/gcid:x", { "categories/gcid:x": "  " })).toBe("X");
    expect(categoryLabel("")).toBe("Unnamed category");
  });
});

describe("attributeLabel", () => {
  const metas = [{ name: "attributes/has_onsite_parking", displayName: "On-site parking" }];
  it("uses metadata displayName from a list or a map", () => {
    expect(attributeLabel("attributes/has_onsite_parking", metas)).toBe("On-site parking");
    expect(attributeLabel("attributes/has_wifi", { "attributes/has_wifi": "Wi-Fi" })).toBe("Wi-Fi");
  });
  it("falls back to words", () => {
    expect(attributeLabel("attributes/has_onsite_parking")).toBe("Has onsite parking");
    expect(attributeLabel("attributes/url_facebook", metas)).toBe("Url facebook");
  });
});

describe("enumLabel", () => {
  it("names the known enums", () => {
    expect(enumLabel("AT_WORK")).toBe("At work");
    expect(enumLabel("PROFILE")).toBe("Logo");
    expect(enumLabel("EXTERIOR")).toBe("Exterior");
    expect(enumLabel("FOOD_AND_DRINK")).toBe("Food and drink");
    expect(enumLabel("LIVE")).toBe("Published");
  });
  it("speaks an unknown enum as words and a missing one as Not set", () => {
    expect(enumLabel("SOME_NEW_THING")).toBe("Some new thing");
    expect(enumLabel(null)).toBe("Not set");
  });
});

describe("statusLabel", () => {
  it("names statuses", () => {
    expect(statusLabel("active")).toBe("Active");
    expect(statusLabel("pending_approval")).toBe("Waiting for approval");
    expect(statusLabel("PUBLISHING")).toBe("Publishing");
  });
  it("falls back to words", () => {
    expect(statusLabel("needs_a_look")).toBe("Needs a look");
    expect(statusLabel("")).toBe("Unknown");
  });
});

describe("guardrailLabel", () => {
  it("shows the message, never the code", () => {
    const text = guardrailLabel("U4", "Contains 1 banned boilerplate phrase(s)");
    expect(text).toBe("Contains 1 banned boilerplate phrase(s)");
    expect(text).not.toContain("U4");
  });
  it("falls back to the rule's plain name, then to a generic line", () => {
    expect(guardrailLabel("U7.url")).toBe("Contains a link");
    expect(guardrailLabel("ZZ.unknown")).toBe("A content rule blocked this");
    expect(guardrailLabel(undefined)).toBe("A content rule blocked this");
  });
  it("covers every rule in the core packs, and lists no rule that no longer exists", () => {
    const ids = allRules().map((r) => r.id);
    expect(ids.length).toBeGreaterThan(30);
    expect(ids.filter((id) => !GUARDRAIL_RULE_IDS.includes(id))).toEqual([]);
    expect(GUARDRAIL_RULE_IDS.filter((id) => !ids.includes(id))).toEqual([]);
  });
});

describe("isMissingTimestamp", () => {
  it("flags null, empty, invalid and epoch values", () => {
    for (const v of [null, undefined, "", "not a date", "1970-01-01T00:00:00Z", "1970-01-01T00:00:00.000Z", 0, new Date(0)])
      expect(isMissingTimestamp(v), String(v)).toBe(true);
  });
  it("passes real timestamps", () => {
    expect(isMissingTimestamp("2026-10-19T05:00:00Z")).toBe(false);
    expect(UNKNOWN_DATE).toBe("Unknown date");
  });
});
