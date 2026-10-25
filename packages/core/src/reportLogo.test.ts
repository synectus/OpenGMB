import sharp from "sharp";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { prepareReportLogo, REPORT_LOGO_MAX } from "./reports/logo";
import { renderReportPdf } from "./reports/pdf";

const solid = (w: number, h: number, fmt: "png" | "jpeg" | "webp") =>
  sharp({ create: { width: w, height: h, channels: 3, background: "#cc3300" } }).toFormat(fmt).toBuffer();

/** Count of image XObjects in a saved PDF (the canary: a plain report has none). */
async function imageCount(pdf: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(pdf);
  let n = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) n++;
  }
  return n;
}

describe("prepareReportLogo", () => {
  it("turns PNG, JPEG and WebP into a small PNG within the limit", async () => {
    for (const fmt of ["png", "jpeg", "webp"] as const) {
      const out = await prepareReportLogo(await solid(1800, 600, fmt));
      expect(out, fmt).not.toBeNull();
      expect(out!.width).toBeLessThanOrEqual(REPORT_LOGO_MAX.width);
      expect(out!.height).toBeLessThanOrEqual(REPORT_LOGO_MAX.height);
      expect(Buffer.from(out!.png.subarray(1, 4)).toString()).toBe("PNG");
      expect(out!.png.length).toBeLessThan(20_000);
    }
  });
  it("does not enlarge a small logo", async () => {
    const out = await prepareReportLogo(await solid(60, 30, "png"));
    expect(out).toMatchObject({ width: 60, height: 30 });
  });
  it("returns null for bytes that are not an image", async () => {
    expect(await prepareReportLogo(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe("report PDFs with a logo", () => {
  const kpis = [{ key: "calls", label: "Calls", total: 5, previousTotal: 4, deltaPct: 0.25 }];
  const perf = {
    title: "T",
    branding: { agencyName: "Agency" },
    periodLabel: "p",
    comparisonLabel: "c",
    locationLabels: ["L"],
    summary: { kpis } as never,
    keywords: [],
    generatedAt: new Date("2026-10-01T00:00:00Z"),
  };
  it("performance PDF embeds the logo only when given one", async () => {
    const logo = (await prepareReportLogo(await solid(400, 200, "png")))!;
    expect(await imageCount(await renderReportPdf(perf))).toBe(0);
    const withLogo = await renderReportPdf({ ...perf, logo });
    expect(await imageCount(withLogo)).toBe(1);
    expect(withLogo.length).toBeLessThan(40_000);
  });
});
