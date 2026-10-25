import { and, asc, eq, inArray } from "drizzle-orm";
import {
  locationGroupMembers,
  locations,
  reportDefinitions,
  reportRuns,
  workspaces,
  type Db,
  type Tx,
} from "@opengmb/db";
import { writeAudit } from "../audit";
import { loadBranding } from "../branding";
import { PERFORMANCE_CONFIG } from "../config/performance";
import { enqueueJob } from "../jobs";
import {
  last30DaysRange,
  lastCompleteMonth,
  lastMonthRange,
  monthsBetween,
  monthOf,
  previousRange,
  type DayRange,
} from "../performance/dates";
import { summarize, topKeywords } from "../performance/queries";
import { reviewStats } from "../reviews/stats";
import type { ActionAuditEntry } from "../registry";
import { buildRunContent } from "./content";
import { reportPeriodLabel } from "./labels";
import { loadReportLogo } from "./logo";
import { renderReportPdf, type ReportBranding } from "./pdf";
import { renderReviewReportPdf } from "./review-pdf";
import { generateReportSummary, performancePrompt, reviewPrompt, type SummaryPrompt } from "./summary";

export const REPORT_GENERATE_QUEUE = "reports.generate";
export const REPORT_MONTHLY_QUEUE = "reports.monthly";
export const REPORT_QUEUE_OPTIONS = { retryLimit: 3, retryDelay: 60, retryBackoff: true } as const;
export const REPORT_KEYWORD_LIMIT = 15;

export type DefinitionRow = typeof reportDefinitions.$inferSelect;

/** The days a definition covers when run at `now`. Custom definitions ignore `now`. */
export function definitionPeriod(
  def: Pick<DefinitionRow, "period" | "customFrom" | "customTo">,
  now: Date,
): DayRange {
  if (def.period === "last_month") return lastMonthRange(now);
  if (def.period === "last_30_days") return last30DaysRange(now);
  return { from: def.customFrom!, to: def.customTo! };
}

/** Complete months (up to the previous calendar month) that overlap `range`. */
export function keywordMonths(range: DayRange, now: Date): string[] {
  const last = lastCompleteMonth(now);
  const from = monthOf(range.from);
  const to = monthOf(range.to) < last ? monthOf(range.to) : last;
  return from > to ? [] : monthsBetween(from, to);
}

export function brandingOf(def: Pick<DefinitionRow, "branding">): ReportBranding {
  const b = (def.branding ?? {}) as Record<string, unknown>;
  return {
    ...(typeof b.agencyName === "string" ? { agencyName: b.agencyName } : {}),
    ...(typeof b.colour === "string" ? { colour: b.colour } : {}),
  };
}

/** Queue a generation job for a run row the caller inserted, inside the caller's transaction. */
export async function createManualRun(
  tx: Tx,
  p: {
    def: DefinitionRow;
    requestedBy: string;
    audit: (entry: ActionAuditEntry) => Promise<void>;
    now?: Date;
  },
): Promise<{ runId: string; jobId: string; periodStart: string; periodEnd: string }> {
  const period = definitionPeriod(p.def, p.now ?? new Date());
  const [run] = await tx
    .insert(reportRuns)
    .values({
      orgId: p.def.orgId,
      definitionId: p.def.id,
      periodStart: period.from,
      periodEnd: period.to,
      trigger: "manual",
      requestedBy: p.requestedBy,
    })
    .returning({ id: reportRuns.id });
  const jobId = await enqueueJob(tx, REPORT_GENERATE_QUEUE, { runId: run!.id });
  await p.audit({
    action: "reports.run_requested",
    entityType: "report_run",
    entityId: run!.id,
    before: null,
    after: { definitionId: p.def.id, periodStart: period.from, periodEnd: period.to, jobId },
  });
  return { runId: run!.id, jobId, periodStart: period.from, periodEnd: period.to };
}

async function setFailed(db: Db, runId: string, orgId: string, error: string) {
  await db.transaction(async (tx) => {
    const [r] = await tx
      .update(reportRuns)
      .set({ status: "failed", error, finishedAt: new Date() })
      .where(and(eq(reportRuns.id, runId), inArray(reportRuns.status, ["queued", "running"])))
      .returning({ id: reportRuns.id });
    if (!r) return;
    await writeAudit(tx, {
      orgId,
      actorUserId: null,
      actorType: "system",
      surface: "worker",
      action: "reports.run_failed",
      entityType: "report_run",
      entityId: runId,
      after: { error },
    });
  });
}

/**
 * The run's AI summary (A7), or null. Only for a definition that turned it on. Tried once per run: the
 * outcome is stored at once, so a retried job reuses it and never pays again. It cannot fail the run:
 * AI off, over a cap, out of credit, a failing AI service or an answer that did not pass the check all
 * leave the report without a summary. The audit row holds ids, counts and cost, never the text.
 */
async function runSummary(
  db: Db,
  run: typeof reportRuns.$inferSelect,
  def: DefinitionRow,
  prompt: SummaryPrompt,
): Promise<string | null> {
  if (!def.aiSummary) return null;
  if (run.summaryStatus !== null) return run.summary;
  const r = await generateReportSummary(db, { orgId: def.orgId, workspaceId: def.workspaceId, prompt });
  await db.transaction(async (tx) => {
    await tx
      .update(reportRuns)
      .set({ summary: r.text, summaryStatus: r.status })
      .where(eq(reportRuns.id, run.id));
    await writeAudit(tx, {
      orgId: def.orgId,
      actorUserId: null,
      actorType: "system",
      surface: "worker",
      action: "reports.summary",
      entityType: "report_run",
      entityId: run.id,
      after: {
        definitionId: def.id,
        status: r.status,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costMicroUsd: r.costMicroUsd,
        chars: r.text?.length ?? 0,
      },
    });
  });
  return r.text;
}

export type RunOutcome = "done" | "skipped" | "failed";

/**
 * Worker side of `reports.generate`: loads the definition, sums the stored performance data (no
 * Google call), renders the PDF in memory and stores it, with one audit row (ids and sizes only).
 * Only a `queued` run is processed, so a re-delivered job is a no-op. A PDF over the size cap fails
 * the run. Unexpected errors throw so pg-boss retries; on the final attempt the run is marked
 * failed.
 */
export async function processReportRun(
  db: Db,
  runId: string,
  deps: { now?: Date; isFinalAttempt?: boolean } = {},
): Promise<RunOutcome> {
  const now = deps.now ?? new Date();
  const [claimed] = await db
    .update(reportRuns)
    .set({ status: "running" })
    .where(and(eq(reportRuns.id, runId), eq(reportRuns.status, "queued")))
    .returning();
  if (!claimed) return "skipped";
  try {
    const [def] = await db
      .select()
      .from(reportDefinitions)
      .where(eq(reportDefinitions.id, claimed.definitionId));
    if (!def) {
      await setFailed(db, runId, claimed.orgId, "definition_missing");
      return "failed";
    }
    if (def.scope === "group" && !def.groupId) {
      await setFailed(db, runId, claimed.orgId, "group_missing");
      return "failed";
    }
    const locs = await db
      .select({ id: locations.id, title: locations.title, name: locations.name })
      .from(locations)
      .where(
        and(
          eq(locations.orgId, def.orgId),
          eq(locations.workspaceId, def.workspaceId),
          def.scope === "locations"
            ? inArray(locations.id, def.locationIds)
            : def.scope === "group"
              ? inArray(
                  locations.id,
                  db
                    .select({ id: locationGroupMembers.locationId })
                    .from(locationGroupMembers)
                    .where(eq(locationGroupMembers.groupId, def.groupId!)),
                )
              : undefined,
        ),
      )
      .orderBy(asc(locations.title), asc(locations.id));
    const [ws] = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, def.workspaceId));
    const range = { from: claimed.periodStart, to: claimed.periodEnd };
    const locationIds = locs.map((l) => l.id);
    const prev = previousRange(range);
    const branding = brandingOf(def);
    // The PDF header falls back to the agency's own name, colour and logo (same order as the share
    // page); the stored content keeps only what the definition itself set.
    const org = await loadBranding(db, def.orgId);
    const pdfBranding: ReportBranding = {
      agencyName: branding.agencyName?.trim() || org.agencyName,
      ...((branding.colour ?? org.primaryColor) ? { colour: (branding.colour ?? org.primaryColor)! } : {}),
    };
    const logo = await loadReportLogo(db, def.orgId);
    let pdf: Buffer;
    let content: unknown;
    if (def.kind === "reviews") {
      const stats = await reviewStats(db, {
        locations: locs.map((l) => ({ id: l.id, label: l.title ?? l.name })),
        range,
      });
      const summary = await runSummary(
        db,
        claimed,
        def,
        reviewPrompt({
          periodStart: range.from,
          periodEnd: range.to,
          previousFrom: prev.from,
          previousTo: prev.to,
          locationCount: locationIds.length,
          stats,
          language: def.language,
        }),
      );
      pdf = Buffer.from(
        await renderReviewReportPdf({
          title: def.name,
          branding: pdfBranding,
          logo,
          periodLabel: `${range.from} to ${range.to}`,
          comparisonLabel: `${prev.from} to ${prev.to}`,
          locationLabels: locs.map((l) => l.title ?? l.name),
          stats,
          generatedAt: now,
          language: def.language,
          comment: def.comment,
          aiSummary: summary,
        }),
      );
      content = {
        v: 1,
        kind: "reviews",
        title: def.name,
        periodStart: range.from,
        periodEnd: range.to,
        previousFrom: prev.from,
        previousTo: prev.to,
        periodLabel: reportPeriodLabel(range.from, range.to, "en"),
        workspaceName: ws?.name ?? "",
        locationCount: locationIds.length,
        language: def.language,
        branding,
        comment: def.comment,
        stats,
      };
    } else {
      const summary = await summarize(db, { locationIds, range });
      const months = keywordMonths(range, now);
      const keywords = await topKeywords(db, { locationIds, months, limit: REPORT_KEYWORD_LIMIT });
      const summaryText = await runSummary(
        db,
        claimed,
        def,
        performancePrompt({
          periodStart: range.from,
          periodEnd: range.to,
          previousFrom: prev.from,
          previousTo: prev.to,
          locationCount: locationIds.length,
          summary,
          keywords,
          language: def.language,
        }),
      );
      pdf = Buffer.from(
        await renderReportPdf({
          title: def.name,
          branding: pdfBranding,
          logo,
          periodLabel: `${range.from} to ${range.to}`,
          comparisonLabel: `${prev.from} to ${prev.to}`,
          locationLabels: locs.map((l) => l.title ?? l.name),
          summary,
          keywords,
          generatedAt: now,
          language: def.language,
          comment: def.comment,
          aiSummary: summaryText,
        }),
      );
      content = buildRunContent({
        title: def.name,
        range,
        previous: prev,
        workspaceName: ws?.name ?? "",
        locationCount: locationIds.length,
        language: def.language,
        branding,
        comment: def.comment,
        summary,
        keywordMonths: months,
        keywords,
      });
    }
    if (pdf.length > PERFORMANCE_CONFIG.reportPdfMaxBytes) {
      await setFailed(db, runId, claimed.orgId, "pdf_too_large");
      return "failed";
    }
    await db.transaction(async (tx) => {
      await tx
        .update(reportRuns)
        .set({ status: "done", pdf, pdfBytes: pdf.length, content, finishedAt: new Date() })
        .where(eq(reportRuns.id, runId));
      await writeAudit(tx, {
        orgId: claimed.orgId,
        actorUserId: null,
        actorType: "system",
        surface: "worker",
        action: "reports.run_completed",
        entityType: "report_run",
        entityId: runId,
        after: {
          definitionId: def.id,
          groupId: def.groupId,
          kind: def.kind,
          language: def.language,
          periodStart: range.from,
          periodEnd: range.to,
          locationCount: locationIds.length,
          pdfBytes: pdf.length,
        },
      });
    });
    return "done";
  } catch (e) {
    if (deps.isFinalAttempt) {
      await setFailed(db, runId, claimed.orgId, "render_failed");
    } else {
      // Let the retry claim it again.
      await db
        .update(reportRuns)
        .set({ status: "queued" })
        .where(and(eq(reportRuns.id, runId), eq(reportRuns.status, "running")));
    }
    throw e;
  }
}
