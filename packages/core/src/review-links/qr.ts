import QRCode from "qrcode";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { pdfSafe } from "../reports/pdf";
import { wrapLines } from "../reports/labels";

const QUIET = 4; // modules of white around the code (the QR standard minimum)

export function qrMatrix(text: string): { size: number; dark: (row: number, col: number) => boolean } {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = modules.size;
  return { size, dark: (r, c) => modules.data[r * size + c] === 1 };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One rect per horizontal run of dark modules; no image library, scales to any size. */
export function qrSvg(text: string, label: string): string {
  const { size, dark } = qrMatrix(text);
  const total = size + QUIET * 2;
  const rects: string[] = [];
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!dark(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < size && dark(r, c)) c++;
      rects.push(`<rect x="${start + QUIET}" y="${r + QUIET}" width="${c - start}" height="1"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="256" height="256" role="img" aria-label="${esc(label)}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/><g fill="#000000">${rects.join("")}</g></svg>`;
}

export const qrPng = (text: string, scale = 10): Promise<Buffer> =>
  QRCode.toBuffer(text, { errorCorrectionLevel: "M", margin: QUIET, scale, type: "png" });

/** A5 counter card: the location, "Tell us how we did on Google", the QR and the short address. Print-safe black on white. */
export async function counterCardPdf(o: { locationName: string; agencyName?: string | null; url: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`Review card ${o.locationName}`));
  const page = doc.addPage([420, 595]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const centre = (text: string, y: number, size: number, f = font) => {
    const t = pdfSafe(text);
    page.drawText(t, { x: (420 - f.widthOfTextAtSize(t, size)) / 2, y, size, font: f, color: rgb(0, 0, 0) });
  };
  if (o.agencyName) centre(o.agencyName, 555, 10);
  let y = 500;
  for (const line of wrapLines(pdfSafe(o.locationName), (s) => bold.widthOfTextAtSize(s, 22), 360)) {
    centre(line, y, 22, bold);
    y -= 28;
  }
  centre("Tell us how we did on Google", y - 6, 16);
  const { size, dark } = qrMatrix(o.url);
  const cell = 260 / (size + QUIET * 2);
  const left = (420 - 260) / 2;
  const top = y - 40;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (dark(r, c)) {
        page.drawRectangle({ x: left + (c + QUIET) * cell, y: top - (r + QUIET + 1) * cell, width: cell + 0.2, height: cell + 0.2, color: rgb(0, 0, 0) });
      }
    }
  }
  centre(o.url.replace(/\?.*$/, "").replace(/^https?:\/\//, ""), top - 260 - 18, 11);
  return doc.save();
}
