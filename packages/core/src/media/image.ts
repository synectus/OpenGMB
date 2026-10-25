import { MEDIA_LIMITS } from "../config/media-limits";
import { CoreError } from "../errors";

export type ImageInfo = {
  format: "jpeg" | "png";
  contentType: "image/jpeg" | "image/png";
  width: number;
  height: number;
};

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bad = (m: string) => new CoreError("INVALID_INPUT", m);

function png(b: Uint8Array): ImageInfo {
  // signature, then the IHDR chunk: length(4) "IHDR" width(4) height(4)
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 24 || String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== "IHDR") {
    throw bad("Not a valid PNG file");
  }
  return {
    format: "png",
    contentType: "image/png",
    width: v.getUint32(16),
    height: v.getUint32(20),
  };
}

function jpeg(b: Uint8Array): ImageInfo {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    // Standalone markers carry no length: TEM, RSTn, SOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    const len = v.getUint16(i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (i + 9 > b.length) break;
      return {
        format: "jpeg",
        contentType: "image/jpeg",
        height: v.getUint16(i + 5),
        width: v.getUint16(i + 7),
      };
    }
    if (marker === 0xd9 || marker === 0xda || len < 2) break; // EOI / scan start before any SOF
    i += 2 + len;
  }
  throw bad("Not a valid JPEG file");
}

/**
 * Identify an image from its first bytes (the declared Content-Type and file name are never
 * trusted) and read its pixel size from the header. Only JPEG and PNG pass; GIF, HEIC, WebP and
 * renamed non-images are INVALID_INPUT. No decoding, so no image library.
 */
export function inspectImage(bytes: Uint8Array): ImageInfo {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return jpeg(bytes);
  }
  if (bytes.length >= 8 && PNG_SIG.every((x, i) => bytes[i] === x)) return png(bytes);
  throw bad("Only JPG and PNG photos are accepted (HEIC, GIF and WebP are not)");
}

/** Google's size and pixel rules for a photo in `category`; INVALID_INPUT with a friendly reason. */
export function assertPhotoLimits(info: ImageInfo, byteSize: number, category: string): void {
  const p = MEDIA_LIMITS.photo;
  if (byteSize > p.maxBytes) throw bad(`Photo is larger than ${p.maxBytes / 1024 / 1024} MB`);
  if (info.width < 1 || info.height < 1) throw bad("Photo has no pixels");
  const exempt = (MEDIA_LIMITS.upload.minimumsExemptCategories as readonly string[]).includes(
    category,
  );
  if (exempt) return;
  if (byteSize < p.minBytes) throw bad(`Photo is smaller than ${p.minBytes / 1024} KB`);
  if (Math.min(info.width, info.height) < p.minShortEdgePx) {
    throw bad(`Photo must be at least ${p.minShortEdgePx}px on the short edge`);
  }
}
