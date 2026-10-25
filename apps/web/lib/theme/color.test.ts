// apps/web/lib/theme/color.test.ts
import { describe, expect, it } from "vitest";
import { buttonPair, contrast, ensureContrast, INK, isHex, mix, WHITE } from "./color";

describe("contrast", () => {
  it("matches WCAG for the Synectus button orange on white", () => {
    expect(contrast("#c2410c", WHITE)).toBeCloseTo(5.18, 2);
  });

  it("canary: Synectus orange #f96535 on white is NOT text-safe (the check can fail)", () => {
    const r = contrast("#f96535", WHITE);
    expect(r).toBeGreaterThan(3);
    expect(r).toBeLessThan(4.5);
  });
});

describe("mix", () => {
  it("blends channel by channel", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#123456", "#ffffff", 0)).toBe("#123456");
    expect(mix("#123456", "#ffffff", 1)).toBe("#ffffff");
  });
});

describe("buttonPair", () => {
  it("keeps a dark colour with white text", () => {
    expect(buttonPair("#c2410c")).toEqual({ bg: "#c2410c", fg: WHITE });
  });

  it("uses near-black text on Synectus orange", () => {
    expect(buttonPair("#f96535")).toEqual({ bg: "#f96535", fg: INK });
  });

  it("darkens a mid grey that neither text colour can read on", () => {
    const { bg, fg } = buttonPair("#777777");
    expect(fg).toBe(WHITE);
    expect(bg).not.toBe("#777777");
    expect(contrast(bg, fg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("ensureContrast", () => {
  it("moves a colour until it reaches the minimum", () => {
    expect(contrast(ensureContrast("#f96535", WHITE, "#000000"), WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it("returns a colour that already passes unchanged", () => {
    expect(ensureContrast("#1a1a1a", WHITE, "#000000")).toBe("#1a1a1a");
  });

  it("returns `toward` when even `toward` cannot reach the minimum (best effort)", () => {
    expect(ensureContrast("#777777", WHITE, "#888888")).toBe("#888888");
    expect(contrast("#888888", WHITE)).toBeLessThan(4.5);
  });
});

describe("isHex", () => {
  it("accepts only #rrggbb", () => {
    expect(isHex("#AbCdEf")).toBe(true);
    expect(isHex("#fff")).toBe(false);
    expect(isHex("red")).toBe(false);
    expect(isHex("#ffffff;}body{display:none")).toBe(false);
    expect(isHex(null)).toBe(false);
  });
});
