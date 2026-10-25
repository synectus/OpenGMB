import sharp from "sharp";

/** Deterministic "photo": a 640x480 RGB gradient with a checker, so the JPEG is well above 10 KB. */
export async function fixturePhoto(seed = 0, w = 640, h = 480): Promise<Uint8Array> {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const c = ((x >> 4) + (y >> 4) + seed) % 2 ? 40 : 0;
      px[i] = ((x * 255) / w + c) | 0;
      px[i + 1] = ((y * 255) / h + c) | 0;
      px[i + 2] = (128 + c) | 0;
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

/** 300x120 PNG with alpha: a rounded rect and a circle drawn from SVG shapes (no text). */
export async function fixtureLogo(): Promise<Uint8Array> {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120"><rect x="4" y="4" width="292" height="112" rx="24" fill="#0f766e"/><circle cx="60" cy="60" r="34" fill="#f59e0b"/><path d="M120 40h140v16H120zM120 70h100v16H120z" fill="#ffffff"/></svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}
