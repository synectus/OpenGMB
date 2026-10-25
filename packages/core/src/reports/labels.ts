// packages/core/src/reports/labels.ts
import { monthEnd, monthOf } from "../performance/dates";

export const REPORT_LANGUAGES = ["en", "es"] as const;
export type ReportLanguage = (typeof REPORT_LANGUAGES)[number];

/** Our own product limit for the reader comment (canvas 4 decision, 2026-10-18). */
export const REPORT_COMMENT_MAX = 500;

const MONTHS: Record<ReportLanguage, string[]> = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
};

/** "September 2026" for a whole calendar month, else "2026-09-18 to 2026-10-17". */
export function reportPeriodLabel(from: string, to: string, lang: ReportLanguage = "en"): string {
  if (from.endsWith("-01") && to === monthEnd(monthOf(from))) {
    const m = MONTHS[lang][Number(from.slice(5, 7)) - 1]!;
    const y = from.slice(0, 4);
    return lang === "es" ? `${m} de ${y}` : `${m} ${y}`;
  }
  return lang === "es" ? `${from} a ${to}` : `${from} to ${to}`;
}

const PASTED: [RegExp, string][] = [
  [/\r\n?/g, "\n"],
  [/\t/g, " "],
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[–—−]/g, "-"],
  [/…/g, "..."],
  [/[\u00A0\u2007\u202F]/g, " "],
];

/** Pasted punctuation to what the PDF fonts can print; trimmed; empty becomes null. */
export function normalizeComment(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = raw;
  for (const [re, to] of PASTED) s = s.replace(re, to);
  s = s.trim();
  return s === "" ? null : s;
}

/** Why a normalised comment cannot be saved, or null. Same character set as pdfSafe, plus newlines. */
export function commentProblem(s: string): string | null {
  if (s.length > REPORT_COMMENT_MAX) {
    return `The comment is ${s.length} characters; the limit is ${REPORT_COMMENT_MAX}`;
  }
  if (/[^\n\x20-\x7E\xA1-\xFF]/.test(s)) {
    return "The comment can only use Latin letters (with accents), numbers and common punctuation, so the PDF can print it";
  }
  return null;
}

/** Greedy word wrap with a caller-supplied width function (font metrics in the PDF). */
export function wrapLines(text: string, width: (s: string) => number, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ").filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (width(next) <= max) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      let w = word;
      while (width(w) > max && w.length > 1) {
        let i = w.length - 1;
        while (i > 1 && width(w.slice(0, i)) > max) i--;
        out.push(w.slice(0, i));
        w = w.slice(i);
      }
      line = w;
    }
    out.push(line);
  }
  return out;
}

type KpiLabels = {
  impressionsTotal: string;
  impressionsMaps: string;
  impressionsSearch: string;
  calls: string;
  websiteClicks: string;
  directions: string;
};

export type PdfLabels = {
  period: string;
  comparedWith: string;
  locations: string;
  andMore: (n: number) => string;
  keyResults: string;
  summary: string;
  metric: string;
  thisPeriod: string;
  previous: string;
  change: string;
  na: string;
  changeNote: string;
  topKeywords: string;
  keyword: string;
  uniqueUsers: string;
  noKeywords: string;
  below: string;
  thresholdNote: string;
  noteFrom: (agency: string) => string;
  note: string;
  generated: (day: string) => string;
  kpi: KpiLabels;
};

/** Every word the PDF prints that is not the user's own text. Spanish copy is a first draft. */
export const PDF_LABELS: Record<ReportLanguage, PdfLabels> = {
  en: {
    period: "Period",
    comparedWith: "Compared with",
    locations: "Locations",
    andMore: (n) => ` and ${n} more`,
    keyResults: "Key results",
    summary: "Summary",
    metric: "Metric",
    thisPeriod: "This period",
    previous: "Previous",
    change: "Change",
    na: "n/a",
    changeNote: "Change compares with the previous period of the same length. n/a: the previous period was 0.",
    topKeywords: "Top search keywords",
    keyword: "Keyword",
    uniqueUsers: "Unique users",
    noKeywords: "No keyword data for this period.",
    below: "below",
    thresholdNote: "Google reports small counts only as 'below a threshold'; such months are not included in the figure.",
    noteFrom: (agency) => `A note from ${agency}`,
    note: "A note for you",
    generated: (day) => `Generated ${day} by OpenGMB`,
    kpi: {
      impressionsTotal: "Profile impressions",
      impressionsMaps: "Impressions on Google Maps",
      impressionsSearch: "Impressions on Google Search",
      calls: "Calls",
      websiteClicks: "Website clicks",
      directions: "Direction requests",
    },
  },
  es: {
    period: "Periodo",
    comparedWith: "Comparado con",
    locations: "Ubicaciones",
    andMore: (n) => ` y ${n} más`,
    keyResults: "Resultados clave",
    summary: "Resumen",
    metric: "Métrica",
    thisPeriod: "Este periodo",
    previous: "Anterior",
    change: "Cambio",
    na: "n/d",
    changeNote: "El cambio se compara con el periodo anterior de la misma duración. n/d: el periodo anterior fue 0.",
    topKeywords: "Principales palabras clave de búsqueda",
    keyword: "Palabra clave",
    uniqueUsers: "Usuarios únicos",
    noKeywords: "No hay datos de palabras clave para este periodo.",
    below: "menos de",
    thresholdNote: "Google solo informa las cifras pequeñas como 'por debajo de un umbral'; esos meses no se suman a la cifra.",
    noteFrom: (agency) => `Una nota de ${agency}`,
    note: "Una nota para usted",
    generated: (day) => `Generado el ${day} por OpenGMB`,
    kpi: {
      impressionsTotal: "Impresiones del perfil",
      impressionsMaps: "Impresiones en Google Maps",
      impressionsSearch: "Impresiones en la Búsqueda de Google",
      calls: "Llamadas",
      websiteClicks: "Clics al sitio web",
      directions: "Solicitudes de indicaciones",
    },
  },
};
