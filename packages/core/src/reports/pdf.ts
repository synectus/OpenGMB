import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { PDF_LABELS, wrapLines, type ReportLanguage } from "./labels";
import type { ReportLogo } from "./logo";
import type { KeywordRow, PerformanceSummary } from "../performance/queries";

export type ReportBranding = { agencyName?: string; colour?: string };

/**
 * Everything the performance PDF shows. It is built from performance totals and keyword counts only. The
 * review report has its own module (review-pdf.ts) that prints review aggregates from reviews/stats.ts;
 * neither ever receives review text, reviewer names or reply text.
 */
export type ReportPdfInput = {
  title: string;
  branding: ReportBranding;
  periodLabel: string;
  comparisonLabel: string;
  locationLabels: string[];
  summary: Pick<PerformanceSummary, "kpis">;
  keywords: KeywordRow[];
  generatedAt: Date;
  /** The agency logo (prepareReportLogo), drawn in the header band; omitted when there is none. */
  logo?: ReportLogo | null;
  /** Labels and headings; the user's own text (title, comment, keywords) is never translated. */
  language?: ReportLanguage;
  /** Already normalised by core (normalizeComment); printed last under "A note from {agency}". */
  comment?: string | null;
  /** The AI summary (core/reports/summary.ts checked it); printed under the header, before the figures. */
  aiSummary?: string | null;
};

/**
 * Draws the logo at the right of the header band on a white plate (so any logo reads on any
 * brand colour). A logo that cannot be embedded is skipped: it never fails the report.
 */
export async function drawHeaderLogo(doc: PDFDocument, page: PDFPage, logo: ReportLogo | null | undefined, pageWidth: number, pageHeight: number) {
  if (!logo) return;
  try {
    const img = await doc.embedPng(logo.png);
    const scale = Math.min(150 / img.width, 38 / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const pad = 6;
    const x = pageWidth - 50 - w;
    const y = pageHeight - 35 - h / 2;
    page.drawRectangle({ x: x - pad, y: y - pad, width: w + 2 * pad, height: h + 2 * pad, color: rgb(1, 1, 1) });
    page.drawImage(img, { x, y, width: w, height: h });
  } catch {
    // skip the logo
  }
}

export const DEFAULT_COLOUR = "#1F4E79";
export const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** The standard PDF fonts only encode WinAnsi: replace anything else so rendering never throws. */
export function pdfSafe(s: string): string {
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

export function colourOf(hex: string | undefined) {
  const h = hex && HEX_COLOUR.test(hex) ? hex : DEFAULT_COLOUR;
  return rgb(
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  );
}

const pct = (n: number | null, na: string) =>
  n === null ? na : `${n > 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const num = (n: number) => n.toLocaleString("en-US");

/** Renders the report. Pure: same input, same text (the PDF metadata carries `generatedAt`). */
export async function renderReportPdf(input: ReportPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(input.title));
  doc.setProducer("OpenGMB");
  doc.setCreator("OpenGMB");
  doc.setCreationDate(input.generatedAt);
  doc.setModificationDate(input.generatedAt);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const colour = colourOf(input.branding.colour);
  const W = 595.28;
  const H = 841.89;
  const M = 50;
  const L = PDF_LABELS[input.language ?? "en"];

  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const text = (s: string, x: number, size: number, f: PDFFont = font, c = rgb(0.1, 0.1, 0.1)) =>
    page.drawText(pdfSafe(s), { x, y, size, font: f, color: c });
  const ensure = (needed: number) => {
    if (y - needed >= M) return;
    page = doc.addPage([W, H]);
    y = H - M;
  };
  const fit = (s: string, f: PDFFont, size: number, max: number) => {
    let out = pdfSafe(s);
    while (out.length > 1 && f.widthOfTextAtSize(out, size) > max) out = out.slice(0, -2);
    return out === pdfSafe(s) ? out : `${out}...`;
  };

  // Header band with the agency name.
  page.drawRectangle({ x: 0, y: H - 70, width: W, height: 70, color: colour });
  y = H - 42;
  page.drawText(pdfSafe(input.branding.agencyName?.trim() || "OpenGMB"), {
    x: M,
    y,
    size: 18,
    font: bold,
    color: rgb(1, 1, 1),
  });
  await drawHeaderLogo(doc, page, input.logo, W, H);
  y = H - 100;
  text(fit(input.title, bold, 20, W - 2 * M), M, 20, bold, colour);
  y -= 22;
  text(`${L.period}: ${input.periodLabel}`, M, 11);
  y -= 15;
  text(`${L.comparedWith}: ${input.comparisonLabel}`, M, 10, font, rgb(0.35, 0.35, 0.35));
  y -= 15;
  const shown = input.locationLabels.slice(0, 8).join(", ");
  const more = input.locationLabels.length > 8 ? L.andMore(input.locationLabels.length - 8) : "";
  text(
    fit(`${L.locations} (${input.locationLabels.length}): ${shown}${more}`, font, 10, W - 2 * M),
    M,
    10,
    font,
    rgb(0.35, 0.35, 0.35),
  );
  y -= 30;

  // The AI summary, first. It was normalised and checked when it was made, so pdfSafe replaces nothing.
  const aiSummary = input.aiSummary?.trim();
  if (aiSummary) {
    ensure(60);
    text(L.summary, M, 14, bold, colour);
    y -= 6;
    for (const line of wrapLines(aiSummary, (s) => font.widthOfTextAtSize(pdfSafe(s), 10), W - 2 * M)) {
      ensure(16);
      y -= 14;
      if (line) text(line, M, 10);
    }
    y -= 26;
  }

  // KPI table.
  text(L.keyResults, M, 14, bold, colour);
  y -= 8;
  const cols = [M, 290, 370, 450];
  const row = (cells: string[], f: PDFFont, c = rgb(0.1, 0.1, 0.1)) => {
    ensure(20);
    y -= 16;
    cells.forEach((cell, i) => text(i === 0 ? fit(cell, f, 10, 230) : cell, cols[i]!, 10, f, c));
  };
  row([L.metric, L.thisPeriod, L.previous, L.change], bold, colour);
  for (const k of input.summary.kpis) {
    row(
      [
        L.kpi[k.key as keyof typeof L.kpi] ?? k.label,
        num(k.total),
        num(k.previousTotal),
        pct(k.deltaPct, L.na),
      ],
      font,
    );
  }
  y -= 10;
  ensure(40);
  text(L.changeNote, M, 8, font, rgb(0.4, 0.4, 0.4));
  y -= 28;

  // Keywords.
  ensure(60);
  text(L.topKeywords, M, 14, bold, colour);
  y -= 8;
  if (input.keywords.length === 0) {
    y -= 16;
    text(L.noKeywords, M, 10);
  } else {
    const kc = [M, 420];
    const krow = (a: string, b: string, f: PDFFont, c = rgb(0.1, 0.1, 0.1)) => {
      ensure(20);
      y -= 16;
      text(fit(a, f, 10, 350), kc[0]!, 10, f, c);
      text(b, kc[1]!, 10, f, c);
    };
    krow(L.keyword, L.uniqueUsers, bold, colour);
    for (const k of input.keywords) {
      const count = !k.isLowerBound
        ? num(k.value)
        : k.value > 0
          ? `${num(k.value)}+`
          : `${L.below} ${num(k.hiddenBelow)}`;
      krow(k.keyword, count, font);
    }
    y -= 10;
    ensure(30);
    text(L.thresholdNote, M, 8, font, rgb(0.4, 0.4, 0.4));
  }

  // The reader comment, last. Normalised on save, so pdfSafe never has to replace anything.
  const comment = input.comment?.trim();
  if (comment) {
    y -= 28;
    ensure(60);
    const agency = input.branding.agencyName?.trim();
    text(agency ? L.noteFrom(agency) : L.note, M, 14, bold, colour);
    y -= 6;
    for (const line of wrapLines(
      comment,
      (s) => font.widthOfTextAtSize(pdfSafe(s), 10),
      W - 2 * M,
    )) {
      ensure(16);
      y -= 14;
      if (line) text(line, M, 10);
    }
  }

  // Footer on the last page.
  page.drawText(pdfSafe(L.generated(input.generatedAt.toISOString().slice(0, 10))), {
    x: M,
    y: 28,
    size: 8,
    font,
    color: rgb(0.5, 0.5, 0.5),
  });
  return doc.save();
}
