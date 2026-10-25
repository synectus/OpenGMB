import { describe, expect, it } from "vitest";
import { POST_IMAGE_SIZE, POST_IMAGE_TEXT, POST_IMAGE_TEXT_BOX } from "./config/post-image-templates";
import { CoreError } from "./errors";
import {
  fitBlock,
  fitText,
  fontFor,
  linePath,
  normaliseText,
  unsupportedChars,
  wrapLines,
} from "./postImages/text-layout";

const SENTENCE = "Spring tune-up special for every make and model, booked this month only";
const opts = { maxPx: 64, minPx: 44, step: 2, maxWidth: 1080, maxLines: 2 };

describe("text layout", () => {
  it("normaliseText collapses whitespace and newlines", () => {
    expect(normaliseText("  a \n\n b  ")).toBe("a b");
  });

  it("unsupportedChars: refuses non-Latin letters, accepts the rupee sign and accents", () => {
    const bad = unsupportedChars("Hola ₹ é ñ нет 你好 नमस्ते", "bold");
    expect(bad).toContain("न");
    expect(bad).toContain("н");
    expect(bad).toContain("你");
    expect(bad).not.toContain("₹");
    expect(bad).not.toContain("é");
    expect(unsupportedChars("Hola ₹ é ñ", "bold")).toEqual([]);
  });

  it("unsupportedChars: refuses a symbol the font cannot draw", () => {
    expect(unsupportedChars("\u{1F600}", "bold")).toEqual(["\u{1F600}"]);
  });

  it("wrapLines wraps to at least 2 lines, each within maxWidth", () => {
    const lines = wrapLines(SENTENCE, "bold", 64, 700);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect(fontFor("bold").getAdvanceWidth(l, 64, { kerning: true })).toBeLessThanOrEqual(700);
  });

  it("fitText: a short headline stays at 64 px on 1 line", () => {
    const r = fitText("Spring sale", "bold", opts);
    expect(r.px).toBe(64);
    expect(r.lines).toHaveLength(1);
  });

  it("fitText: a long headline shrinks and uses at most 2 lines", () => {
    const r = fitText(SENTENCE, "bold", opts);
    expect(r.px).toBeLessThan(64);
    expect(r.lines.length).toBeLessThanOrEqual(2);
  });

  it("fitText: 80 W with no spaces is refused INVALID_INPUT", () => {
    expect(() => fitText("W".repeat(80), "bold", opts)).toThrowError(CoreError);
    try {
      fitText("W".repeat(80), "bold", opts);
    } catch (e) {
      expect((e as CoreError).code).toBe("INVALID_INPUT");
    }
  });

  it("fitText: Devanagari is refused with INVALID_INPUT", () => {
    expect(() => fitText("नमस्ते", "bold", opts)).toThrowError(/Latin-script/);
  });

  it("fitBlock: 80-char headline + 120-char subline fits band, is refused for frame", () => {
    const headline = "Spring brake and tyre check, fixed price for every make and model this month".padEnd(80, "x").slice(0, 80);
    const subline = "Book online or call the workshop today and we will fit you in this week with a free courtesy car included".padEnd(120, "x").slice(0, 120);
    const H = POST_IMAGE_SIZE.height;
    const boxFor = (l: "band" | "frame") => {
      const b = POST_IMAGE_TEXT_BOX[l];
      return { width: b.width, maxHeight: H - POST_IMAGE_TEXT.bottomMarginPx - b.top, sublineMaxLines: b.sublineMaxLines, ruleBelowHeadlinePx: b.ruleBelowHeadlinePx };
    };
    const band = fitBlock(headline, subline, boxFor("band"));
    expect(band.height).toBeLessThanOrEqual(boxFor("band").maxHeight);
    expect(() => fitBlock(headline, subline, boxFor("frame"))).toThrowError(/second line/);
  });

  it("linePath returns path data starting with M", () => {
    const d = linePath("Hi", "bold", 64, 0, 64);
    expect(d.length).toBeGreaterThan(0);
    expect(d.startsWith("M")).toBe(true);
  });
});
