import { createHash } from "node:crypto";
import sharp, { type OutputInfo, type OverlayOptions, type Sharp } from "sharp";
import { MEDIA_LIMITS } from "../config/media-limits";
import {
  POST_IMAGE_COLORS,
  POST_IMAGE_JPEG,
  POST_IMAGE_SIZE,
  POST_IMAGE_TEXT,
  POST_IMAGE_TEXT_BOX,
  type PostImageLayout,
} from "../config/post-image-templates";
import { CoreError } from "../errors";
import { fitBlock, linePath, type FontWeight } from "./text-layout";

export type BrandedLayoutInput = {
  layout: PostImageLayout;
  headline: string; // normalised already
  subline: string; // "" when absent
  /** The logo's size after fitting it into the layout's box (renderBrandedImage computes it). */
  logo: { width: number; height: number } | null;
};

type Box = { left: number; top: number; width: number; height: number };

const { width: W, height: H } = POST_IMAGE_SIZE;
const LOGO_PAD = 16;
const FRAME_PX = 48;

const BOXES = {
  band: {
    photo: { left: 0, top: 0, width: W, height: H },
    logoBox: { left: 40, top: 40, width: 220, height: 110 },
  },
  frame: {
    photo: { left: FRAME_PX, top: FRAME_PX, width: 1104, height: 600 },
    logoBox: { left: 900, top: 690, width: 252, height: 162 },
  },
} as const satisfies Record<PostImageLayout, { photo: Box; logoBox: Box }>;

export function layoutBoxes(layout: PostImageLayout) {
  const t = POST_IMAGE_TEXT_BOX[layout];
  return {
    ...BOXES[layout],
    text: { x: t.x, top: t.top, width: t.width, maxHeight: H - POST_IMAGE_TEXT.bottomMarginPx - t.top },
  };
}

/** The largest logo that fits the layout's box once padding is removed. */
export function logoInnerSize(layout: PostImageLayout): { width: number; height: number } {
  const b = BOXES[layout].logoBox;
  return { width: b.width - 2 * LOGO_PAD, height: b.height - 2 * LOGO_PAD };
}

/** Where the (already fitted) logo pixels go, and the plate behind it (band only: the frame is white already). */
export function logoPlacement(layout: PostImageLayout, logo: { width: number; height: number }) {
  const b = BOXES[layout].logoBox;
  if (layout === "band") {
    return {
      left: b.left + LOGO_PAD,
      top: b.top + LOGO_PAD,
      plate: { left: b.left, top: b.top, width: logo.width + 2 * LOGO_PAD, height: logo.height + 2 * LOGO_PAD },
    };
  }
  return {
    left: b.left + Math.round((b.width - logo.width) / 2),
    top: b.top + Math.round((b.height - logo.height) / 2),
    plate: null,
  };
}

export type PlacedLine = { text: string; weight: FontWeight; px: number; x: number; baseline: number };

const BASELINE = 0.95; // first baseline sits this fraction of the font size below the line top

/** Every text line, where it is drawn, and the accent rule's y (frame). Throws INVALID_INPUT when the text does not fit. */
export function placeText(layout: PostImageLayout, headline: string, subline: string) {
  const T = POST_IMAGE_TEXT;
  const box = layoutBoxes(layout);
  const rule = POST_IMAGE_TEXT_BOX[layout].ruleBelowHeadlinePx;
  const fit = fitBlock(headline, subline, {
    width: box.text.width,
    maxHeight: box.text.maxHeight,
    sublineMaxLines: POST_IMAGE_TEXT_BOX[layout].sublineMaxLines,
    ruleBelowHeadlinePx: rule,
  });
  const lines: PlacedLine[] = [];
  fit.headlineLines.forEach((text, i) =>
    lines.push({
      text,
      weight: "bold",
      px: fit.headlinePx,
      x: box.text.x,
      baseline: box.text.top + i * fit.headlinePx * T.lineHeight + fit.headlinePx * BASELINE,
    }),
  );
  const headlineBottom = box.text.top + fit.headlineLines.length * fit.headlinePx * T.lineHeight;
  const subTop = headlineBottom + rule + T.gapPx;
  fit.sublineLines.forEach((text, i) =>
    lines.push({
      text,
      weight: "regular",
      px: T.sublinePx,
      x: box.text.x,
      baseline: subTop + i * T.sublinePx * T.lineHeight + T.sublinePx * BASELINE,
    }),
  );
  return { lines, ruleY: rule ? headlineBottom + 8 : null };
}

const n = (v: number) => String(Math.round(v));

/** Full-canvas transparent SVG: shapes and `<path>` text outlines only, never `<text>` (no system font). */
export function overlaySvg(input: BrandedLayoutInput): string {
  const { surface, text } = POST_IMAGE_COLORS;
  const { lines, ruleY } = placeText(input.layout, input.headline, input.subline);
  const parts: string[] = [];
  if (input.layout === "band") {
    parts.push(`<rect x="0" y="630" width="${W}" height="270" fill="${surface}"/>`);
    if (input.logo) {
      const p = logoPlacement("band", input.logo).plate!;
      parts.push(
        `<rect id="logo-plate" x="${p.left}" y="${p.top}" width="${p.width}" height="${p.height}" rx="16" fill="${surface}"/>`,
      );
    }
  } else {
    const f = BOXES.frame.photo;
    parts.push(
      `<rect x="0" y="0" width="${W}" height="${f.top}" fill="${surface}"/>`,
      `<rect x="0" y="${f.top + f.height}" width="${W}" height="${H - f.top - f.height}" fill="${surface}"/>`,
      `<rect x="0" y="${f.top}" width="${f.left}" height="${f.height}" fill="${surface}"/>`,
      `<rect x="${f.left + f.width}" y="${f.top}" width="${W - f.left - f.width}" height="${f.height}" fill="${surface}"/>`,
    );
    if (ruleY !== null) {
      parts.push(`<rect x="${POST_IMAGE_TEXT_BOX.frame.x}" y="${n(ruleY)}" width="120" height="6" fill="${text}"/>`);
    }
  }
  for (const l of lines) {
    parts.push(`<path d="${linePath(l.text, l.weight, l.px, l.x, l.baseline)}" fill="${text}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

export type RenderBrandedInput = Omit<BrandedLayoutInput, "logo"> & { photo: Uint8Array; logo: Uint8Array | null };
export type RenderedImage = {
  bytes: Uint8Array;
  contentType: "image/jpeg" | "image/png";
  width: 1200;
  height: 900;
  overlay: string;
  pixelsSha256: string;
};

/**
 * Pure and deterministic: same inputs, same bytes (libvips, librsvg and the JPEG encoder are bundled
 * in sharp's prebuilt packages; text is path outlines, never SVG text).
 */
export async function renderBrandedImage(input: RenderBrandedInput): Promise<RenderedImage> {
  // 1. Logo, fitted into the layout's box.
  let logo: { png: Buffer; width: number; height: number } | null = null;
  if (input.logo) {
    const inner = logoInnerSize(input.layout);
    try {
      const { data, info } = await sharp(input.logo)
        .resize(inner.width, inner.height, { fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true });
      logo = { png: data, width: info.width, height: info.height };
    } catch {
      throw new CoreError("INVALID_INPUT", "The client's logo could not be read");
    }
  }
  // 2. Overlay (throws INVALID_INPUT for text that cannot be drawn or does not fit).
  const overlay = overlaySvg({ layout: input.layout, headline: input.headline, subline: input.subline, logo });
  // 3. Photo, auto-oriented and cover-resized to its box.
  const box = BOXES[input.layout].photo;
  let photo: { data: Buffer; info: OutputInfo };
  try {
    photo = await sharp(input.photo)
      .rotate()
      .resize(box.width, box.height, { fit: "cover", position: "centre" })
      .flatten({ background: POST_IMAGE_COLORS.surface })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new CoreError("INVALID_INPUT", "The photo could not be read");
  }
  const photoRaw = { width: photo.info.width, height: photo.info.height, channels: 3 as const };
  let base: Sharp;
  if (input.layout === "band") {
    base = sharp(photo.data, { raw: photoRaw });
  } else {
    const framed = await sharp({ create: { width: W, height: H, channels: 3, background: POST_IMAGE_COLORS.surface } })
      .composite([{ input: await sharp(photo.data, { raw: photoRaw }).png().toBuffer(), left: box.left, top: box.top }])
      .removeAlpha()
      .raw()
      .toBuffer();
    base = sharp(framed, { raw: { width: W, height: H, channels: 3 } });
  }
  // 4. Overlay, then logo.
  const layers: OverlayOptions[] = [{ input: Buffer.from(overlay), left: 0, top: 0 }];
  if (logo) {
    const at = logoPlacement(input.layout, logo);
    layers.push({ input: logo.png, left: at.left, top: at.top });
  }
  const { data: raw, info } = await base.composite(layers).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixelsSha256 = createHash("sha256").update(raw).digest("hex");
  // 5. Encode. A near-flat image can come out under Google's minimum size; the same pixels go out as PNG then.
  const jpeg = await sharp(raw, { raw: info }).jpeg({ ...POST_IMAGE_JPEG }).toBuffer();
  if (jpeg.length >= MEDIA_LIMITS.photo.minBytes) {
    return { bytes: jpeg, contentType: "image/jpeg", width: W, height: H, overlay, pixelsSha256 };
  }
  const png = await sharp(raw, { raw: info }).png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer();
  return { bytes: png, contentType: "image/png", width: W, height: H, overlay, pixelsSha256 };
}
