import { describe, expect, it } from "vitest";
import { brandingInputError, contrastReadout, previewBrand, previewStyle } from "./branding-form";
import { brandTokens } from "./theme/brand";
import { WHITE } from "./theme/color";
import { LIGHT } from "./theme/tokens";

describe("brandingInputError", () => {
  const ok = { logoUrl: "", primaryColor: "#1f5f8b", accentColor: "" };

  it("accepts empty fields (they clear) and valid ones", () => {
    expect(brandingInputError(ok)).toBeNull();
    expect(brandingInputError({ ...ok, logoUrl: "https://example.com/logo.png" })).toBeNull();
  });

  it("uses the canvas text for a bad colour and a non-https logo", () => {
    expect(brandingInputError({ ...ok, primaryColor: "#1f5f8" })).toBe("INVALID_INPUT: Use a colour like #1d4ed8.");
    expect(brandingInputError({ ...ok, accentColor: "teal" })).toBe("INVALID_INPUT: Use a colour like #1d4ed8.");
    expect(brandingInputError({ ...ok, logoUrl: "http://example.com/logo.png" })).toBe(
      "INVALID_INPUT: The logo URL must start with https://.",
    );
  });
});

describe("contrastReadout", () => {
  it("canary: #1f5f8b passes with white text at 6.8:1 (the canvas example)", () => {
    expect(contrastReadout("#1f5f8b")).toEqual({ tone: "good", text: "White text on #1f5f8b: 6.8:1, passes" });
  });

  it("canary: #f5d90a gets near-black text on the darker shade the app really uses", () => {
    const button = brandTokens({ primaryColor: "#f5d90a", accentColor: null })!.light.primary;
    expect(button).not.toBe("#f5d90a");
    expect(contrastReadout("#f5d90a")).toEqual({
      tone: "warn",
      text: `White text on #f5d90a is too faint, so buttons use near-black text on a darker shade, ${button}, that stands out on a white page.`,
    });
  });

  it("canary: #777777 (white 4.48:1) never reads as passing", () => {
    const r = contrastReadout("#777777")!;
    expect(r.tone).toBe("warn");
    expect(r.text).not.toContain("passes");
  });

  it.each(["#1f5f8b", "#0f766e", "#1d4ed8", "#f5d90a", "#777777", "#8a8a8a", "#f96535", "#ffffff", "#000000"])(
    "agrees with brandTokens for %s",
    (hex) => {
      const light = brandTokens({ primaryColor: hex, accentColor: null })!.light;
      const r = contrastReadout(hex)!;
      const passes = light.primary === hex && light["primary-foreground"] === WHITE;
      expect(r.tone).toBe(passes ? "good" : "warn");
      if (light["primary-foreground"] !== WHITE) expect(r.text).toContain("near-black");
      if (light.primary !== hex) expect(r.text).toContain(light.primary!);
    },
  );

  it("says nothing for an incomplete colour", () => {
    expect(contrastReadout("#1f5f8")).toBeNull();
    expect(contrastReadout("")).toBeNull();
  });
});

describe("previewStyle", () => {
  it("is the light theme with the agency overrides, as CSS variables", () => {
    const s = previewStyle("#1f5f8b", "#0f766e");
    const t = brandTokens({ primaryColor: "#1f5f8b", accentColor: "#0f766e" })!.light;
    expect(s["--primary"]).toBe(t.primary);
    expect(s["--brand"]).toBe(t.brand);
    expect(s["--background"]).toBe(LIGHT.background);
    expect(Object.keys(s)).toHaveLength(Object.keys(LIGHT).length);
  });

  it("canary: falls back to the default tokens while a colour is incomplete", () => {
    expect(previewStyle("#1f5f8", "")["--primary"]).toBe(LIGHT.primary);
  });
});

describe("previewBrand", () => {
  it("shows the default OpenGMB mark when nothing is set", () => {
    expect(previewBrand({ agencyName: "Synectus", logoUrl: "", primaryColor: "", accentColor: "" })).toEqual({
      name: "OpenGMB",
      mark: "O",
      logoUrl: null,
      branded: false,
    });
  });

  it("uses the agency name and an https logo once branded", () => {
    expect(
      previewBrand({ agencyName: "Acme", logoUrl: "https://x.test/l.png", primaryColor: "#1f5f8b", accentColor: "" }),
    ).toEqual({ name: "Acme", mark: "A", logoUrl: "https://x.test/l.png", branded: true });
    expect(
      previewBrand({ agencyName: "Acme", logoUrl: "http://x.test/l.png", primaryColor: "#1f5f8b", accentColor: "" }).logoUrl,
    ).toBeNull();
  });
});
