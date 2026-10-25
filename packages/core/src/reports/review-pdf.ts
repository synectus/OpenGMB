import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { wrapLines, type ReportLanguage } from "./labels";
import type { ReportLogo } from "./logo";
import { colourOf, drawHeaderLogo, pdfSafe, type ReportBranding } from "./pdf";
import {
  changeCount, changePoints, changeRating, formatHours, percent, type ReviewStats,
} from "../reviews/stats";

export type ReviewPdfInput = {
  title: string;
  branding: ReportBranding;
  periodLabel: string;
  comparisonLabel: string;
  locationLabels: string[];
  stats: ReviewStats;
  generatedAt: Date;
  /** The agency logo (prepareReportLogo), drawn in the header band. */
  logo?: ReportLogo | null;
  language?: ReportLanguage;
  /** Already normalised by core (normalizeComment). */
  comment?: string | null;
  /** The AI summary (core/reports/summary.ts checked it); printed under the header, before the figures. */
  aiSummary?: string | null;
};

const EN = {
  period: "Period", comparedWith: "Compared with", locations: "Locations",
  andMore: (n: number) => ` and ${n} more`,
  summary: "Summary", atAGlance: "At a glance", metric: "Metric", thisPeriod: "This period", previous: "Previous", change: "Change",
  na: "n/a", newReviews: "New reviews", averageRating: "Average rating", replyRate: "Reply rate",
  timeToReply: "Time to reply (median)", starMix: "Star mix", stars: (n: number) => `${n} stars`,
  byMonth: "Rating by month", month: "Month", count: "Reviews", rating: "Average",
  byLocation: "By location", location: "Location",
  noReviews: "No new reviews in this period.",
  replyNote: "Reply rate counts reviews from the period that have a visible reply today.",
  timeNote: "Time to reply is measured to the latest version of each reply on Google.",
  changeNote: "Change compares with the previous period of the same length. n/a: nothing to compare.",
  noteFrom: (agency: string) => `A note from ${agency}`, note: "A note for you",
  generated: (day: string) => `Generated ${day} by OpenGMB`,
};
const ES: typeof EN = {
  period: "Periodo", comparedWith: "Comparado con", locations: "Ubicaciones",
  andMore: (n) => ` y ${n} más`,
  summary: "Resumen", atAGlance: "De un vistazo", metric: "Métrica", thisPeriod: "Este periodo", previous: "Anterior", change: "Cambio",
  na: "n/d", newReviews: "Reseñas nuevas", averageRating: "Calificación media", replyRate: "Tasa de respuesta",
  timeToReply: "Tiempo de respuesta (mediana)", starMix: "Mezcla de estrellas", stars: (n) => `${n} estrellas`,
  byMonth: "Calificación por mes", month: "Mes", count: "Reseñas", rating: "Media",
  byLocation: "Por ubicación", location: "Ubicación",
  noReviews: "No hay reseñas nuevas en este periodo.",
  replyNote: "La tasa de respuesta cuenta las reseñas del periodo que hoy tienen una respuesta visible.",
  timeNote: "El tiempo de respuesta se mide hasta la última versión de cada respuesta en Google.",
  changeNote: "El cambio se compara con el periodo anterior de la misma duración. n/d: nada con qué comparar.",
  noteFrom: (agency) => `Una nota de ${agency}`, note: "Una nota para usted",
  generated: (day) => `Generado el ${day} por OpenGMB`,
};
const LABELS: Record<ReportLanguage, typeof EN> = { en: EN, es: ES };

/** Renders the Review report. Pure: figures in, bytes out. Never receives review text, names or reply text. */
export async function renderReviewReportPdf(input: ReviewPdfInput): Promise<Uint8Array> {
  const lang = input.language ?? "en";
  const L = LABELS[lang];
  const na = (s: string) => (s === "n/a" ? L.na : s);
  const s = input.stats;
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(input.title));
  doc.setProducer("OpenGMB");
  doc.setCreator("OpenGMB");
  doc.setCreationDate(input.generatedAt);
  doc.setModificationDate(input.generatedAt);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const colour = colourOf(input.branding.colour);
  const W = 595.28, H = 841.89, M = 50;
  const grey = rgb(0.35, 0.35, 0.35);
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const text = (t: string, x: number, size: number, f: PDFFont = font, c = rgb(0.1, 0.1, 0.1)) =>
    page.drawText(pdfSafe(t), { x, y, size, font: f, color: c });
  const ensure = (needed: number) => {
    if (y - needed >= M) return;
    page = doc.addPage([W, H]);
    y = H - M;
  };
  const fit = (t: string, f: PDFFont, size: number, max: number) => {
    let out = pdfSafe(t);
    while (out.length > 1 && f.widthOfTextAtSize(out, size) > max) out = out.slice(0, -2);
    return out === pdfSafe(t) ? out : `${out}...`;
  };
  const row = (cells: string[], xs: number[], f: PDFFont, c = rgb(0.1, 0.1, 0.1)) => {
    ensure(20);
    y -= 16;
    cells.forEach((cell, i) => text(i === 0 ? fit(cell, f, 10, xs[1]! - xs[0]! - 10) : cell, xs[i]!, 10, f, c));
  };

  page.drawRectangle({ x: 0, y: H - 70, width: W, height: 70, color: colour });
  y = H - 42;
  page.drawText(pdfSafe(input.branding.agencyName?.trim() || "OpenGMB"), { x: M, y, size: 18, font: bold, color: rgb(1, 1, 1) });
  await drawHeaderLogo(doc, page, input.logo, W, H);
  y = H - 100;
  text(fit(input.title, bold, 20, W - 2 * M), M, 20, bold, colour);
  y -= 22;
  text(`${L.period}: ${input.periodLabel}`, M, 11);
  y -= 15;
  text(`${L.comparedWith}: ${input.comparisonLabel}`, M, 10, font, grey);
  y -= 15;
  const shown = input.locationLabels.slice(0, 8).join(", ");
  const more = input.locationLabels.length > 8 ? L.andMore(input.locationLabels.length - 8) : "";
  text(fit(`${L.locations} (${input.locationLabels.length}): ${shown}${more}`, font, 10, W - 2 * M), M, 10, font, grey);
  y -= 30;

  const aiSummary = input.aiSummary?.trim();
  if (aiSummary) {
    ensure(60);
    text(L.summary, M, 14, bold, colour);
    y -= 6;
    for (const line of wrapLines(aiSummary, (t) => font.widthOfTextAtSize(pdfSafe(t), 10), W - 2 * M)) {
      ensure(16);
      y -= 14;
      if (line) text(line, M, 10);
    }
    y -= 26;
  }

  text(L.atAGlance, M, 14, bold, colour);
  y -= 8;
  const xs = [M, 270, 360, 450];
  row([L.metric, L.thisPeriod, L.previous, L.change], xs, bold, colour);
  const rating = (n: number | null) => (n === null ? L.na : n.toFixed(1));
  row([L.newReviews, String(s.newReviews), String(s.previousNewReviews), na(changeCount(s.newReviews, s.previousNewReviews))], xs, font);
  row([L.averageRating, rating(s.averageRating), rating(s.previousAverageRating), na(changeRating(s.averageRating, s.previousAverageRating))], xs, font);
  row([L.replyRate, na(percent(s.replyRate)), na(percent(s.previousReplyRate)), na(changePoints(s.replyRate, s.previousReplyRate))], xs, font);
  row([L.timeToReply, formatHours(s.medianHoursToReply, lang), "", ""], xs, font);
  y -= 10;
  ensure(40);
  text(L.replyNote, M, 8, font, grey);
  y -= 11;
  text(L.timeNote, M, 8, font, grey);
  y -= 11;
  text(L.changeNote, M, 8, font, grey);
  y -= 28;

  ensure(120);
  text(L.starMix, M, 14, bold, colour);
  y -= 8;
  if (s.newReviews === 0) {
    y -= 16;
    text(L.noReviews, M, 10);
  } else {
    const top = Math.max(...s.starMix, 1);
    for (let n = 5; n >= 1; n--) {
      ensure(20);
      y -= 16;
      const count = s.starMix[n - 1]!;
      text(L.stars(n), M, 10);
      page.drawRectangle({ x: 130, y: y - 2, width: Math.max(1, (count / top) * 260), height: 9, color: colour });
      text(String(count), 400, 10);
    }
  }
  y -= 24;

  ensure(60);
  text(L.byMonth, M, 14, bold, colour);
  y -= 8;
  const mx = [M, 200, 300];
  row([L.month, L.count, L.rating], mx, bold, colour);
  for (const t of s.trend) row([t.month, String(t.count), rating(t.averageRating)], mx, font);
  y -= 24;

  ensure(60);
  text(L.byLocation, M, 14, bold, colour);
  y -= 8;
  const lx = [M, 230, 290, 370, 450];
  row([L.location, L.count, L.rating, L.replyRate, L.timeToReply.replace(" (median)", "").replace(" (mediana)", "")], lx, bold, colour);
  for (const l of s.byLocation) {
    row([l.label, String(l.newReviews), rating(l.averageRating), na(percent(l.replyRate)), formatHours(l.medianHoursToReply, lang)], lx, font);
  }

  const comment = input.comment?.trim();
  if (comment) {
    y -= 28;
    ensure(60);
    const agency = input.branding.agencyName?.trim();
    text(agency ? L.noteFrom(agency) : L.note, M, 14, bold, colour);
    y -= 6;
    for (const line of wrapLines(comment, (t) => font.widthOfTextAtSize(pdfSafe(t), 10), W - 2 * M)) {
      ensure(16);
      y -= 14;
      if (line) text(line, M, 10);
    }
  }
  page.drawText(pdfSafe(L.generated(input.generatedAt.toISOString().slice(0, 10))), { x: M, y: 28, size: 8, font, color: rgb(0.5, 0.5, 0.5) });
  return doc.save();
}
