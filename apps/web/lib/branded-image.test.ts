import { describe, expect, it } from "vitest";
import { formProblem, initialForm, toActionInput, type BrandedForm } from "./branded-image";

const WS = "11111111-1111-4111-8111-111111111111";
const PHOTO = "22222222-2222-4222-8222-222222222222";
const ok = (o: Partial<BrandedForm> = {}): BrandedForm => ({
  ...initialForm({ hasLogo: true }, PHOTO),
  headline: "Open late on Fridays",
  ...o,
});

describe("initialForm", () => {
  it("starts on the band layout with the photo and logo choice filled in", () => {
    expect(initialForm({ hasLogo: true }, PHOTO)).toEqual({
      photoImageId: PHOTO, layout: "band", headline: "", subline: "", useLogo: true,
    });
    expect(initialForm({ hasLogo: false }, null)).toMatchObject({ photoImageId: null, useLogo: false });
  });
});

describe("formProblem", () => {
  it("accepts a complete form", () => {
    expect(formProblem(ok())).toBeNull();
  });
  it("names each problem", () => {
    expect(formProblem(ok({ photoImageId: null }))).toBe("branded.problemNoPhoto");
    expect(formProblem(ok({ headline: "   " }))).toBe("branded.problemNoHeadline");
    expect(formProblem(ok({ headline: "a".repeat(81) }))).toBe("branded.problemHeadlineLong");
    expect(formProblem(ok({ subline: "b".repeat(121) }))).toBe("branded.problemSublineLong");
  });
  it("accepts the exact limits", () => {
    expect(formProblem(ok({ headline: "a".repeat(80), subline: "b".repeat(120) }))).toBeNull();
  });
});

describe("toActionInput", () => {
  it("builds the action input and refuses a form without a photo", () => {
    expect(toActionInput(ok({ layout: "frame", subline: "Call us" }), WS)).toEqual({
      workspaceId: WS, photoImageId: PHOTO, layout: "frame",
      headline: "Open late on Fridays", subline: "Call us", useLogo: true,
    });
    expect(() => toActionInput(ok({ photoImageId: null }), WS)).toThrow();
  });
});
