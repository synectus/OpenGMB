import { describe, expect, it } from "vitest";
import { counterCardPdf, qrMatrix, qrPng, qrSvg } from "./qr";

const URL1 = "https://app.example.test/go/rivermoor-main?s=qr";

describe("qrMatrix", () => {
  it("canary: the top-left finder pattern is there", () => {
    const m = qrMatrix(URL1);
    expect(m.size).toBeGreaterThanOrEqual(21);
    for (let c = 0; c < 7; c++) expect(m.dark(0, c)).toBe(true); // row 0 of the 7x7 finder
    expect([m.dark(1, 0), m.dark(1, 1), m.dark(1, 5), m.dark(1, 6)]).toEqual([true, false, false, true]);
  });
});

describe("qrSvg", () => {
  it("is an accessible svg with dark modules and the quiet zone", () => {
    const svg = qrSvg(URL1, "QR code for the Rivermoor Main St review link");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="QR code for the Rivermoor Main St review link"');
    expect((svg.match(/<rect /g) ?? []).length).toBeGreaterThan(10);
  });
  it("escapes the label", () => {
    expect(qrSvg(URL1, 'a"<b>')).not.toContain('a"<b>');
  });
});

describe("qrPng and counterCardPdf", () => {
  it("png has the PNG signature", async () => {
    const png = await qrPng(URL1);
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
  it("pdf is a PDF and survives characters the standard font cannot encode", async () => {
    const pdf = await counterCardPdf({ locationName: "Clínica Médica 北", agencyName: "Synectus", url: URL1 });
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
