import { describe, expect, it } from "vitest";
import * as core from "@opengmb/core";
import {
  analyseTemplate,
  notAllowedHere,
  TEMPLATE_VARIABLES,
  templateTokens,
  unknownVariableText,
  VARIABLE_HELP,
} from "./reply-templates";

const BODIES = [
  "Thank you for your feedback at {location_name}. Call {phone}.",
  "Hi {reviewer_first_name}, thanks!",
  "Hi {first_name}, {phone} {phone}",
  "No variables at all.",
  "Broken {brace and {} empty",
];

describe("parity with core (packages/core/src/reviews/templates.ts)", () => {
  it("canary: the same 3 variables in the same order", () => {
    expect([...TEMPLATE_VARIABLES]).toEqual([...core.TEMPLATE_VARIABLES]);
    expect(VARIABLE_HELP.map((v) => v.name)).toEqual(core.TEMPLATE_VARIABLES.map((v) => `{${v}}`));
  });

  it.each(BODIES)("tokens and generic agree with core for %s", (body) => {
    expect(templateTokens(body)).toEqual(core.templateTokens(body));
    expect(analyseTemplate(body).generic).toBe(core.isGenericTemplate(body));
  });
});

describe("analyseTemplate", () => {
  it("fills the sample values into the preview and lists unknown variables", () => {
    expect(analyseTemplate("Hi {reviewer_first_name}, call {location_name} at {phone}.")).toEqual({
      unknown: [],
      generic: false,
      preview: "Hi Jordan, call Sample Clinic at (555) 010-0100.",
    });
    const a = analyseTemplate("Hi {first_name}, thank you for your feedback.");
    expect(a.unknown).toEqual(["first_name"]);
    expect(a.preview).toBe("Hi {first_name}, thank you for your feedback.");
  });

  it("says which variables are unknown, in the canvas words", () => {
    expect(unknownVariableText([])).toBeNull();
    expect(unknownVariableText(["first_name"])).toBe("Unknown variable {first_name}");
    expect(unknownVariableText(["a", "b"])).toBe("Unknown variable {a}, {b}");
  });
});

describe("notAllowedHere", () => {
  it("blocks only a reviewer-name template in a generic-only workspace", () => {
    expect(notAllowedHere(false, true)).toBe(true);
    expect(notAllowedHere(true, true)).toBe(false);
    expect(notAllowedHere(false, false)).toBe(false);
  });
});
