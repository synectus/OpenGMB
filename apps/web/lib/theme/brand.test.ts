// apps/web/lib/theme/brand.test.ts
import { describe, expect, it } from "vitest";
import { contrast } from "./color";
import { brandCss, brandTokens, shellBrand } from "./brand";
import { DARK, LIGHT } from "./tokens";

const SAMPLES = ["#1d4ed8", "#0f766e", "#7c3aed", "#facc15", "#000000", "#ffffff", "#f96535", "#777777"];

type Pair = NonNullable<ReturnType<typeof brandTokens>>;

function expectReadable(t: Pair) {
  for (const [theme, base] of [
    [t.light, LIGHT],
    [t.dark, DARK],
  ] as const) {
    if (theme.primary) {
      expect(contrast(theme["primary-foreground"]!, theme.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme["primary-foreground"]!, theme["primary-hover"]!)).toBeGreaterThanOrEqual(4.5);
      for (const surface of [base.background, base.card, base.secondary]) {
        expect(contrast(theme.primary, surface)).toBeGreaterThanOrEqual(3);
      }
    }
    expect(contrast(theme["brand-foreground"]!, theme.brand!)).toBeGreaterThanOrEqual(4.5);
    for (const surface of [base.background, base.card, base.secondary]) {
      expect(contrast(theme["brand-text"]!, surface)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(theme["brand-text"]!, theme["brand-tint"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.ring!, base.background)).toBeGreaterThanOrEqual(3);
    expect(contrast(theme.ring!, base.secondary)).toBeGreaterThanOrEqual(3);
  }
}

describe("brandTokens", () => {
  it("returns null without valid colours", () => {
    expect(brandTokens(null)).toBeNull();
    expect(brandTokens({ primaryColor: null, accentColor: null })).toBeNull();
  });

  it("refuses a value that could break out of the style tag", () => {
    expect(brandCss({ primaryColor: "#ffffff;}body{display:none", accentColor: null })).toBeNull();
  });

  it("uses the agency primary for buttons", () => {
    const t = brandTokens({ primaryColor: "#1d4ed8", accentColor: null })!;
    expect(t.light.primary).toBe("#1d4ed8");
    expect(t.light["primary-foreground"]).toBe("#ffffff");
  });

  it.each(SAMPLES)("every pair stays readable for agency colour %s", (c) => {
    const t = brandTokens({ primaryColor: c, accentColor: c })!;
    expectReadable(t);
  });

  it("stays readable with a primary colour only", () => {
    expectReadable(brandTokens({ primaryColor: "#1d4ed8", accentColor: null })!);
  });

  it("stays readable with an accent colour only, and emits no primary keys", () => {
    const t = brandTokens({ primaryColor: null, accentColor: "#0f766e" })!;
    expectReadable(t);
    expect(t.light.primary).toBeUndefined();
    expect(t.dark.primary).toBeUndefined();
  });

  it("stays readable with a light primary and a dark accent", () => {
    expectReadable(brandTokens({ primaryColor: "#facc15", accentColor: "#1d4ed8" })!);
  });
});

describe("brandTokens sweep", () => {
  it("stays readable on every surface for all 4096 three-digit hex colours", () => {
    const digits = "0123456789abcdef";
    let checked = 0;
    for (const a of digits) {
      for (const b of digits) {
        for (const c of digits) {
          const hex = `#${a}${a}${b}${b}${c}${c}`;
          expectReadable(brandTokens({ primaryColor: hex, accentColor: hex })!);
          checked++;
        }
      }
    }
    expect(checked).toBe(4096);
  });
});

describe("shellBrand", () => {
  it("shows OpenGMB by Synectus when the agency set no logo or colour", () => {
    expect(
      shellBrand({ agencyName: "Synectus", logoUrl: null, primaryColor: null, accentColor: null }),
    ).toEqual({ name: "OpenGMB", subline: "by Synectus", mark: "O", logoUrl: null });
  });

  it("shows the agency once it set a colour", () => {
    expect(
      shellBrand({ agencyName: "Example Agency", logoUrl: null, primaryColor: "#1d4ed8", accentColor: null }),
    ).toEqual({ name: "Example Agency", subline: "Powered by OpenGMB", mark: "E", logoUrl: null });
  });

  it("keeps OpenGMB when the agency only renamed itself", () => {
    expect(
      shellBrand({ agencyName: "Renamed Co", logoUrl: null, primaryColor: null, accentColor: null }).name,
    ).toBe("OpenGMB");
  });

  it("handles missing branding", () => {
    expect(shellBrand(null).name).toBe("OpenGMB");
  });
});
