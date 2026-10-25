import opentype from "opentype.js";
import { POST_IMAGE_TEXT } from "../config/post-image-templates";
import { CoreError } from "../errors";
import bold from "./fonts/inter-bold";
import regular from "./fonts/inter-regular";

export type FontWeight = "bold" | "regular";

const cache = new Map<FontWeight, opentype.Font>();

/** Parsed once per process. */
export function fontFor(weight: FontWeight): opentype.Font {
  let font = cache.get(weight);
  if (!font) {
    const buf = Buffer.from(weight === "bold" ? bold : regular, "base64");
    font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    cache.set(weight, font);
  }
  return font;
}

/** Trim and collapse every whitespace run (newlines too) to one space. */
export const normaliseText = (s: string): string => s.replace(/\s+/gu, " ").trim();

/**
 * Unique code points that cannot be used: letters outside the Latin script (English only, a product
 * decision 2026-10-23), and anything the bundled font has no glyph for. Spaces are ignored.
 */
export function unsupportedChars(text: string, weight: FontWeight): string[] {
  const font = fontFor(weight);
  const bad = new Set<string>();
  for (const ch of text) {
    if (/\s/u.test(ch)) continue;
    if ((/\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch)) || font.charToGlyph(ch).index === 0) bad.add(ch);
  }
  return [...bad];
}

const width = (line: string, weight: FontWeight, px: number) =>
  fontFor(weight).getAdvanceWidth(line, px, { kerning: true });

/** Greedy by word. A single word wider than maxWidth stays on its own line (callers check widths). */
export function wrapLines(text: string, weight: FontWeight, px: number, maxWidth: number): string[] {
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && width(next, weight, px) > maxWidth) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function refuseUnsupported(text: string, weight: FontWeight): void {
  const bad = unsupportedChars(text, weight);
  if (bad.length) {
    throw new CoreError(
      "INVALID_INPUT",
      `These characters cannot be used: ${bad.join(" ")}. Only Latin-script (English) text is supported.`,
    );
  }
}

const TOO_LONG = "The text is too long for this layout. Shorten it.";

const fits = (lines: string[], weight: FontWeight, px: number, maxWidth: number) =>
  lines.every((l) => width(l, weight, px) <= maxWidth);

export function fitText(
  text: string,
  weight: FontWeight,
  opts: { maxPx: number; minPx: number; step: number; maxWidth: number; maxLines: number },
): { px: number; lines: string[] } {
  refuseUnsupported(text, weight);
  for (let px = opts.maxPx; px >= opts.minPx; px -= opts.step) {
    const lines = wrapLines(text, weight, px, opts.maxWidth);
    if (lines.length <= opts.maxLines && fits(lines, weight, px, opts.maxWidth)) return { px, lines };
  }
  throw new CoreError("INVALID_INPUT", TOO_LONG);
}

/**
 * Fits headline and subline as one block. The subline stays at its fixed size; the headline shrinks
 * from max to min until the whole block's height fits.
 */
export function fitBlock(
  headline: string,
  subline: string,
  box: { width: number; maxHeight: number; sublineMaxLines: number; ruleBelowHeadlinePx: number },
): { headlinePx: number; headlineLines: string[]; sublineLines: string[]; height: number } {
  const T = POST_IMAGE_TEXT;
  refuseUnsupported(headline, "bold");
  refuseUnsupported(subline, "regular");
  let sublineLines: string[] = [];
  if (subline) {
    sublineLines = wrapLines(subline, "regular", T.sublinePx, box.width);
    if (sublineLines.length > box.sublineMaxLines || !fits(sublineLines, "regular", T.sublinePx, box.width)) {
      throw new CoreError("INVALID_INPUT", "The second line is too long for this layout. Shorten it.");
    }
  }
  const sublineHeight = subline ? T.gapPx + sublineLines.length * T.sublinePx * T.lineHeight : 0;
  for (let px = T.headlinePx.max; px >= T.headlinePx.min; px -= T.headlinePx.step) {
    const headlineLines = wrapLines(headline, "bold", px, box.width);
    if (headlineLines.length > T.headlineMaxLines || !fits(headlineLines, "bold", px, box.width)) continue;
    const height = headlineLines.length * px * T.lineHeight + box.ruleBelowHeadlinePx + sublineHeight;
    if (height <= box.maxHeight) return { headlinePx: px, headlineLines, sublineLines, height };
  }
  throw new CoreError("INVALID_INPUT", TOO_LONG);
}

export function linePath(line: string, weight: FontWeight, px: number, x: number, baselineY: number): string {
  return fontFor(weight).getPath(line, x, baselineY, px, { kerning: true }).toPathData(2);
}
