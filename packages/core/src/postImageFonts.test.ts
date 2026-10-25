import { createHash } from "node:crypto";
import opentype from "opentype.js";
import { describe, expect, it } from "vitest";
import { POST_IMAGE_FONTS } from "./config/post-image-templates";
import bold from "./postImages/fonts/inter-bold";
import regular from "./postImages/fonts/inter-regular";

describe("bundled Inter fonts", () => {
  const weights = { bold, regular } as const;
  for (const w of ["bold", "regular"] as const) {
    it(`${w}: matches the recorded sha256 and draws the rupee sign`, () => {
      const buf = Buffer.from(weights[w], "base64");
      expect(createHash("sha256").update(buf).digest("hex")).toBe(POST_IMAGE_FONTS[w].sha256);
      const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      expect(font.charToGlyph("₹").index).toBeGreaterThan(0);
    });
  }
});
