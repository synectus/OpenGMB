import { describe, expect, it } from "vitest";
import {
  PDF_LABELS,
  REPORT_COMMENT_MAX,
  commentProblem,
  normalizeComment,
  reportPeriodLabel,
  wrapLines,
} from "./reports/labels";
import { pdfSafe } from "./reports/pdf";

describe("reportPeriodLabel", () => {
  it("names a whole calendar month, otherwise prints the dates", () => {
    expect(reportPeriodLabel("2026-09-01", "2026-09-30")).toBe("September 2026");
    expect(reportPeriodLabel("2026-09-01", "2026-09-30", "es")).toBe("septiembre de 2026");
    expect(reportPeriodLabel("2024-02-01", "2024-02-29")).toBe("February 2024");
    expect(reportPeriodLabel("2026-09-18", "2026-10-17")).toBe("2026-09-18 to 2026-10-17");
    expect(reportPeriodLabel("2026-09-18", "2026-10-17", "es")).toBe("2026-09-18 a 2026-10-17");
    expect(reportPeriodLabel("2026-09-01", "2026-09-29")).toBe("2026-09-01 to 2026-09-29");
  });
});

describe("normalizeComment and commentProblem", () => {
  it("maps pasted punctuation to what the PDF can print, trims, and empties to null", () => {
    expect(normalizeComment("  “Great” month – it’s up… \r\nNext line\t ")).toBe(
      '"Great" month - it\'s up... \nNext line',
    );
    expect(normalizeComment("   ")).toBeNull();
    expect(normalizeComment(null)).toBeNull();
    expect(normalizeComment(undefined)).toBeNull();
  });
  it("accepts Spanish, refuses what the PDF cannot print, and counts after normalising", () => {
    expect(commentProblem("¡Las llamadas subieron! ¿Seguimos así? Año, señal.")).toBeNull();
    expect(commentProblem("Great month \u{1F389}")).toMatch(/can only use/);
    expect(commentProblem("x".repeat(REPORT_COMMENT_MAX))).toBeNull();
    expect(commentProblem("x".repeat(REPORT_COMMENT_MAX + 1))).toMatch(/limit is 500/);
    // An accepted comment never meets pdfSafe's replacement.
    const ok = normalizeComment("It’s “fine” — really")!;
    expect(commentProblem(ok)).toBeNull();
    expect(pdfSafe(ok)).toBe(ok);
  });
});

describe("wrapLines", () => {
  const len = (s: string) => s.length;
  it("wraps on spaces, keeps blank lines, and cuts a word longer than the line", () => {
    expect(wrapLines("aaa bbb ccc", len, 7)).toEqual(["aaa bbb", "ccc"]);
    expect(wrapLines("a\n\nb", len, 7)).toEqual(["a", "", "b"]);
    expect(wrapLines("abcdefghijklmno", len, 10)).toEqual(["abcdefghij", "klmno"]);
    expect(wrapLines("", len, 10)).toEqual([""]);
  });
});

describe("PDF_LABELS", () => {
  it("has the same keys in every language and only printable characters", () => {
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(PDF_LABELS.es)).toEqual(keys(PDF_LABELS.en));
    expect(keys(PDF_LABELS.es.kpi)).toEqual(keys(PDF_LABELS.en.kpi));
    for (const lang of ["en", "es"] as const) {
      const L = PDF_LABELS[lang];
      const strings = [
        ...Object.values(L).filter((v): v is string => typeof v === "string"),
        ...Object.values(L.kpi),
        L.andMore(3),
        L.noteFrom("Synectus"),
        L.generated("2026-10-12"),
      ];
      for (const s of strings) expect(pdfSafe(s), `${lang}: ${s}`).toBe(s);
    }
  });
  it("keeps the English strings the existing PDF test reads", () => {
    expect(PDF_LABELS.en.kpi.impressionsTotal).toBe("Profile impressions");
    expect(PDF_LABELS.en.kpi.calls).toBe("Calls");
    expect(PDF_LABELS.en.below).toBe("below");
  });
});
