import { z } from "zod";
import type { KeywordRow, PerformanceSummary } from "../performance/queries";
import { REPORT_LANGUAGES, reportPeriodLabel, type ReportLanguage } from "./labels";

const kpi = z.object({
  key: z.string(),
  label: z.string(),
  total: z.number(),
  previousTotal: z.number(),
  delta: z.number(),
  deltaPct: z.number().nullable(),
});
const keyword = z.object({
  keyword: z.string(),
  value: z.number(),
  isLowerBound: z.boolean(),
  hiddenBelow: z.number(),
});

/** What a run's PDF showed. Version 1. Performance numbers and keywords only: never review text. */
export const runContentSchema = z.object({
  v: z.literal(1),
  title: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  previousFrom: z.string(),
  previousTo: z.string(),
  /** English label for the page: "September 2026" or "2026-09-18 to 2026-10-17". */
  periodLabel: z.string(),
  workspaceName: z.string(),
  locationCount: z.number(),
  language: z.enum(REPORT_LANGUAGES),
  branding: z.object({ agencyName: z.string().optional(), colour: z.string().optional() }),
  comment: z.string().nullable(),
  kpis: z.array(kpi),
  keywordMonths: z.array(z.string()),
  keywords: z.array(keyword),
});
export type RunContent = z.infer<typeof runContentSchema>;

export function buildRunContent(p: {
  title: string;
  range: { from: string; to: string };
  previous: { from: string; to: string };
  workspaceName: string;
  locationCount: number;
  language: ReportLanguage;
  branding: { agencyName?: string; colour?: string };
  comment: string | null;
  summary: Pick<PerformanceSummary, "kpis">;
  keywordMonths: string[];
  keywords: KeywordRow[];
}): RunContent {
  return {
    v: 1,
    title: p.title,
    periodStart: p.range.from,
    periodEnd: p.range.to,
    previousFrom: p.previous.from,
    previousTo: p.previous.to,
    periodLabel: reportPeriodLabel(p.range.from, p.range.to, "en"),
    workspaceName: p.workspaceName,
    locationCount: p.locationCount,
    language: p.language,
    branding: p.branding,
    comment: p.comment,
    kpis: p.summary.kpis.map((k) => ({
      key: k.key,
      label: k.label,
      total: k.total,
      previousTotal: k.previousTotal,
      delta: k.delta,
      deltaPct: k.deltaPct,
    })),
    keywordMonths: p.keywordMonths,
    keywords: p.keywords,
  };
}

/** A stored snapshot, or null for runs made before snapshots and for anything malformed. */
export function parseRunContent(json: unknown): RunContent | null {
  const r = runContentSchema.safeParse(json);
  return r.success ? r.data : null;
}
const locationStats = z.object({
  locationId: z.string(),
  label: z.string(),
  newReviews: z.number(),
  averageRating: z.number().nullable(),
  replyRate: z.number().nullable(),
  medianHoursToReply: z.number().nullable(),
});

/** What a Review report run showed. Counts, ratings and times only: never review text, reviewer names or reply text. */
export const reviewRunContentSchema = z.object({
  v: z.literal(1),
  kind: z.literal("reviews"),
  title: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  previousFrom: z.string(),
  previousTo: z.string(),
  periodLabel: z.string(),
  workspaceName: z.string(),
  locationCount: z.number(),
  language: z.enum(REPORT_LANGUAGES),
  branding: z.object({ agencyName: z.string().optional(), colour: z.string().optional() }),
  comment: z.string().nullable(),
  stats: z.object({
    newReviews: z.number(),
    previousNewReviews: z.number(),
    averageRating: z.number().nullable(),
    previousAverageRating: z.number().nullable(),
    replyRate: z.number().nullable(),
    previousReplyRate: z.number().nullable(),
    medianHoursToReply: z.number().nullable(),
    starMix: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]),
    trend: z.array(z.object({ month: z.string(), count: z.number(), averageRating: z.number().nullable() })),
    byLocation: z.array(locationStats),
  }),
});
export type ReviewRunContent = z.infer<typeof reviewRunContentSchema>;
