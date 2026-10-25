import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MEDIA_LIMITS } from "./config/media-limits";
import { inspectImage } from "./media/image";
import { fixtureLogo, fixturePhoto } from "./postImages/test-fixtures";
import { POST_IMAGE_TEXT_BOX, type PostImageLayout } from "./config/post-image-templates";
import { layoutBoxes, overlaySvg, placeText, renderBrandedImage } from "./postImages/branded";
import { fontFor } from "./postImages/text-layout";

const base = { headline: "Spring tune-up, 20% off", subline: "Book by 30 November", logo: { width: 188, height: 78 } };
const longHeadline = "Spring brake and tyre check fixed price for every make and model this month".padEnd(80, "e").slice(0, 80);
const longSubline = "Book online or call the workshop today and we will fit you in this week with a free courtesy car".padEnd(120, "e").slice(0, 120);
const frameSubline = "Book online or call the workshop today";

describe("overlaySvg", () => {
  for (const layout of ["band", "frame"] as const) {
    it(`${layout}: path outlines only, white surface, near-black text, deterministic`, () => {
      const svg = overlaySvg({ ...base, layout });
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain('width="1200" height="900"');
      expect(svg).not.toContain("<text");
      expect(svg.match(/<path d="M/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
      expect(svg).toContain("#FFFFFF");
      expect(svg).toContain("#111111");
      expect(overlaySvg({ ...base, layout })).toBe(svg);
    });
  }

  it("band: the logo plate exists only when there is a logo", () => {
    expect(overlaySvg({ ...base, layout: "band" })).toContain('id="logo-plate"');
    expect(overlaySvg({ ...base, layout: "band", logo: null })).not.toContain("logo-plate");
  });

  // The frame's text box is 800 px wide, so its longest accepted headline is shorter than 80 characters.
  for (const [layout, headline, subline] of [
    ["band", longHeadline, longSubline],
    ["frame", "Spring brake and tyre check, fixed price this month", frameSubline],
  ] as const) {
    it(`${layout}: the longest accepted text stays inside the text box`, () => {
      const { lines } = placeText(layout as PostImageLayout, headline, subline);
      const box = layoutBoxes(layout);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const l of lines) {
        const bb = fontFor(l.weight).getPath(l.text, l.x, l.baseline, l.px, { kerning: true }).getBoundingBox();
        expect(bb.x1).toBeGreaterThanOrEqual(box.text.x);
        expect(bb.x2).toBeLessThanOrEqual(box.text.x + box.text.width);
        expect(bb.y1).toBeGreaterThanOrEqual(box.text.top);
        expect(bb.y2).toBeLessThanOrEqual(box.text.top + box.text.maxHeight);
      }
      expect(POST_IMAGE_TEXT_BOX[layout].width).toBe(box.text.width);
    });
  }
});

// Snapshot note: a sharp, libvips or font upgrade changes the pixel and JPEG hashes below.
// Regenerate with `vitest -u` only after looking at a render.
describe("renderBrandedImage", () => {
  const base = { layout: "band" as const, headline: "Spring tune-up, 20% off", subline: "Book by 30 November" };
  const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

  it("renders the same image every time for the same inputs (P7 Done when), band", async () => {
    const input = { ...base, photo: await fixturePhoto(), logo: await fixtureLogo() };
    const a = await renderBrandedImage(input);
    const b = await renderBrandedImage(input);
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).toBe(0);
    expect(a.pixelsSha256).toBe(b.pixelsSha256);
    expect(a.contentType).toBe("image/jpeg");
    expect(inspectImage(a.bytes)).toMatchObject({ contentType: "image/jpeg", width: 1200, height: 900 });
    expect(a.bytes.length).toBeGreaterThanOrEqual(MEDIA_LIMITS.photo.minBytes);
    expect(a.bytes.length).toBeLessThanOrEqual(MEDIA_LIMITS.photo.maxBytes);
    expect(a.overlay).not.toContain("<text");
    await expect(a.overlay).toMatchFileSnapshot("./__snapshots__/branded-band.svg");
    expect(a.pixelsSha256).toMatchInlineSnapshot(`"50ac9042b98e2df9b0556f997e65903a56299085b9b78d099cf9ec09e4360112"`);
    expect(sha256(a.bytes)).toMatchInlineSnapshot(`"6125fb35107ff9e9889fc94101c43505665428a5966975d8a9485d87fdc6ccf2"`);
  });

  it("renders the same image every time for the same inputs, frame", async () => {
    const input = { ...base, layout: "frame" as const, photo: await fixturePhoto(), logo: await fixtureLogo() };
    const a = await renderBrandedImage(input);
    const b = await renderBrandedImage(input);
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).toBe(0);
    expect(a.pixelsSha256).toBe(b.pixelsSha256);
    expect(inspectImage(a.bytes)).toMatchObject({ contentType: "image/jpeg", width: 1200, height: 900 });
    expect(a.overlay).not.toContain("<text");
    await expect(a.overlay).toMatchFileSnapshot("./__snapshots__/branded-frame.svg");
    expect(a.pixelsSha256).toMatchInlineSnapshot(`"d40ce12f9f7f96ed059f5ed16e2f121ab78f03a8b98ab9b0a2732d5bc7901067"`);
    expect(sha256(a.bytes)).toMatchInlineSnapshot(`"6ae8f2e356ac0357e4a3a2eaae6b6cf091af79fcd97ea356f763c87f07088a49"`);
  });

  it("canary: each input changes the image (8 variants, 8 distinct images)", async () => {
    const photo = await fixturePhoto();
    const logo = await fixtureLogo();
    const variants = [
      { ...base, photo, logo },
      { ...base, photo, logo, headline: "Winter tune-up, 20% off" },
      { ...base, photo, logo, headline: "A much longer headline that wraps onto a second line" },
      { ...base, photo, logo, subline: "Call us today" },
      { ...base, photo: await fixturePhoto(1), logo },
      { ...base, photo, logo: null },
      { ...base, photo, logo, layout: "frame" as const },
      { ...base, photo, logo, subline: "" },
    ];
    const hashes = new Set((await Promise.all(variants.map(renderBrandedImage))).map((r) => r.pixelsSha256));
    expect(hashes.size).toBe(variants.length);
  });

  it("refuses non-Latin text, whatever the script, with INVALID_INPUT", async () => {
    const photo = await fixturePhoto();
    for (const headline of ["नमस्ते", "Привет", "你好"]) {
      await expect(renderBrandedImage({ ...base, headline, photo, logo: null })).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: expect.stringContaining("Latin-script"),
      });
    }
  });

  it("refuses photo bytes that are not an image with INVALID_INPUT", async () => {
    await expect(renderBrandedImage({ ...base, photo: new Uint8Array(100), logo: null })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "The photo could not be read",
    });
  });

  it("refuses a logo that cannot be read with INVALID_INPUT", async () => {
    await expect(
      renderBrandedImage({ ...base, photo: await fixturePhoto(), logo: new Uint8Array(100) }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
