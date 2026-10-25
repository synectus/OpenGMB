import { and, eq, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  PERFORMANCE_CONFIG,
  REPORT_GENERATE_QUEUE,
  REPORT_MONTHLY_QUEUE,
  REPORT_QUEUE_OPTIONS,
  createShareLink,
  getIntegration,
  lastMonthRange,
  loadBranding,
  loadReportLogo,
  localParts,
  processReportRun,
  recordJobRun,
  shareUrl,
  writeAudit,
} from "@opengmb/core";
import { reportDefinitions, reportRuns, reportShareLinks, workspaces, type Db } from "@opengmb/db";
import { resendSendEmail, type DigestDeps } from "./digest";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const LOGO_CID = "agency-logo";

export function renderReportEmail(p: {
  name: string;
  periodStart: string;
  periodEnd: string;
  url: string;
  expiresAt: Date;
  kind?: "performance" | "reviews";
  /** The agency name, printed under the logo; the logo itself is an inline image (see LOGO_CID). */
  agencyName?: string;
  hasLogo?: boolean;
  /** The run's AI summary (A7), shown first; the same text as in the PDF and on the share page. */
  summary?: string | null;
}) {
  const noun = p.kind === "reviews" ? "review report" : "performance report";
  const period = `${p.periodStart} to ${p.periodEnd}`;
  const expires = p.expiresAt.toISOString().slice(0, 10);
  const summary = p.summary?.trim() ?? "";
  const text = [
    `Your ${noun} "${p.name}" for ${period} is ready.`,
    "",
    ...(summary ? [summary, ""] : []),
    `Open the report: ${p.url}`,
    "",
    `The link works without logging in and expires on ${expires}.`,
  ].join("\n");
  const agency = p.agencyName?.trim() ?? "";
  const logo = p.hasLogo
    ? `<p><img src="cid:${LOGO_CID}" alt="${escapeHtml(agency)}" height="40" style="display:block"></p>`
    : "";
  const html =
    logo +
    `<p>Your ${noun} <strong>${escapeHtml(p.name)}</strong> for ${escapeHtml(period)} is ready.</p>` +
    (summary ? `<p>${escapeHtml(summary)}</p>` : "") +
    `<p><a href="${escapeHtml(p.url)}">Open the report</a></p>` +
    `<p>The link works without logging in and expires on ${expires}.</p>`;
  return { subject: `${noun[0]!.toUpperCase()}${noun.slice(1)}: ${p.name} (${period})`, html, text };
}

export type MonthlyResult = { definitions: number; generated: number; emailed: number };

/**
 * Monthly report emails (the 1st at 09:00 in the client's time zone, found by an hourly sweep). For every definition with schedule 'monthly' and
 * recipients: make last month's run, generate its PDF, create a 30-day share link and email the
 * link (never an attachment, never review text). Idempotent per definition per month: the run is
 * unique per (definition, period) for scheduled runs and `emailed_at` marks completion, so a second
 * run the same month sends nothing, and a retry after a failed send resumes where it stopped. No
 * API key or sender: logs and does nothing, like the daily digest. Failures are collected and the
 * job throws at the end so pg-boss retries.
 */
export async function runMonthlyReports(db: Db, deps: DigestDeps): Promise<MonthlyResult> {
  const result: MonthlyResult = { definitions: 0, generated: 0, emailed: 0 };
  if (!deps.apiKey) {
    console.log("[worker] monthly reports skipped: RESEND_API_KEY not set");
    return result;
  }
  if (!deps.from) {
    console.log("[worker] monthly reports skipped: EMAIL_FROM not set");
    return result;
  }
  const from = deps.from;
  const now = (deps.now ?? (() => new Date()))();
  const [, cronHour, cronDom] = PERFORMANCE_CONFIG.monthlyReportCron.split(" ").map(Number) as [number, number, number];
  const rows = await db
    .select({ def: reportDefinitions, timeZone: workspaces.timeZone })
    .from(reportDefinitions)
    .innerJoin(workspaces, eq(workspaces.id, reportDefinitions.workspaceId))
    .where(
      and(
        eq(reportDefinitions.schedule, "monthly"),
        deps.orgIds ? inArray(reportDefinitions.orgId, deps.orgIds) : undefined,
      ),
    );
  let failed = 0;

  for (const { def, timeZone } of rows) {
    if (def.recipients.length === 0) continue;
    // Due once the client's local clock has reached the 1st at 14:00 (the sweep runs hourly; the
    // run is unique per definition and period, so every later sweep that month finds it done).
    const local = localParts(now, timeZone);
    if (local.day !== cronDom || local.hour < cronHour) continue;
    const period = lastMonthRange(new Date(Date.UTC(local.year, local.month - 1, local.day)));
    result.definitions++;
    try {
      const where = and(
        eq(reportRuns.definitionId, def.id),
        eq(reportRuns.periodStart, period.from),
        eq(reportRuns.periodEnd, period.to),
        eq(reportRuns.trigger, "schedule"),
      );
      await db
        .insert(reportRuns)
        .values({
          orgId: def.orgId,
          definitionId: def.id,
          periodStart: period.from,
          periodEnd: period.to,
          trigger: "schedule",
        })
        .onConflictDoNothing();
      let [run] = await db.select().from(reportRuns).where(where);
      if (!run) throw new Error(`scheduled run missing for definition ${def.id}`);

      if (run.status === "queued") {
        if ((await processReportRun(db, run.id, { now })) === "done") result.generated++;
        [run] = await db.select().from(reportRuns).where(where);
      }
      if (run!.status !== "done") {
        if (run!.status === "failed") console.error(`[worker] monthly report ${run!.id} failed`);
        else failed++; // still queued or running: try again on the next attempt
        continue;
      }
      if (run!.emailedAt) continue;

      const link = await db.transaction(async (tx) => {
        const l = await createShareLink(tx, {
          orgId: def.orgId,
          reportRunId: run!.id,
          createdBy: null,
          expiresInDays: PERFORMANCE_CONFIG.monthlyEmailLinkDays,
          now,
        });
        await writeAudit(tx, {
          orgId: def.orgId,
          actorUserId: null,
          actorType: "system",
          surface: "worker",
          action: "reports.share_created",
          entityType: "report_share_link",
          entityId: l.linkId,
          after: { runId: run!.id, expiresAt: l.expiresAt.toISOString(), monthly: true },
        });
        return l;
      });
      const brand = await loadBranding(db, def.orgId);
      const logo = await loadReportLogo(db, def.orgId);
      const message = renderReportEmail({
        name: def.name,
        periodStart: period.from,
        periodEnd: period.to,
        url: shareUrl(link.token, deps.appUrl),
        expiresAt: link.expiresAt,
        kind: def.kind,
        agencyName: brand.agencyName,
        hasLogo: Boolean(logo),
        summary: run!.summary,
      });
      const attachments = logo
        ? [
            {
              filename: "logo.png",
              content: Buffer.from(logo.png).toString("base64"),
              contentType: "image/png",
              contentId: LOGO_CID,
            },
          ]
        : undefined;
      try {
        for (const to of def.recipients) {
          await deps.sendEmail({
            from,
            to,
            ...message,
            ...(attachments ? { attachments } : {}),
            idempotencyKey: `report-${run!.id}-${to}`,
          });
        }
      } catch (e) {
        // The link was never delivered in full: revoke it so it does not linger.
        await db
          .update(reportShareLinks)
          .set({ revokedAt: new Date() })
          .where(eq(reportShareLinks.id, link.linkId));
        throw e;
      }
      await db.transaction(async (tx) => {
        await tx.update(reportRuns).set({ emailedAt: now }).where(eq(reportRuns.id, run!.id));
        await writeAudit(tx, {
          orgId: def.orgId,
          actorUserId: null,
          actorType: "system",
          surface: "worker",
          action: "reports.monthly_emailed",
          entityType: "report_run",
          entityId: run!.id,
          after: { definitionId: def.id, recipientCount: def.recipients.length },
        });
      });
      result.emailed++;
    } catch (e) {
      failed++;
      console.error(`[worker] monthly report for definition ${def.id} failed`, e);
    }
  }
  console.log(
    `[worker] monthly reports ${now.toISOString().slice(0, 13)}: ${JSON.stringify(result)}, ${failed} failed`,
  );
  if (failed > 0) throw new Error(`monthly reports: ${failed} failure(s)`);
  return result;
}

/** Creates the report queues and the hourly monthly-report sweep. Safe to call on every start. */
export async function registerReportSchedule(boss: PgBoss) {
  for (const queue of [REPORT_GENERATE_QUEUE, REPORT_MONTHLY_QUEUE]) {
    await boss.createQueue(queue, REPORT_QUEUE_OPTIONS);
    await boss.updateQueue(queue, REPORT_QUEUE_OPTIONS);
  }
  await boss.schedule(
    REPORT_MONTHLY_QUEUE,
    PERFORMANCE_CONFIG.monthlyReportSweepCron,
    {},
    { tz: "UTC" },
  );
}

/** Report queues, schedule and their workers. */
export async function registerReportJobs(boss: PgBoss, db: Db) {
  await registerReportSchedule(boss);
  await boss.work<{ runId: string }, void, { includeMetadata: true }>(
    REPORT_GENERATE_QUEUE,
    { includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) {
        const outcome = await processReportRun(db, job.data.runId, {
          isFinalAttempt: job.retryCount >= job.retryLimit,
        });
        console.log(`[worker] ${REPORT_GENERATE_QUEUE} job ${job.id} processed (${outcome})`);
      }
    },
  );
  await boss.work(REPORT_MONTHLY_QUEUE, async () => {
    const apiKey = getIntegration("RESEND_API_KEY");
    await recordJobRun(
      db,
      "monthly_reports",
      () =>
        runMonthlyReports(db, {
          sendEmail: resendSendEmail(apiKey ?? ""),
          apiKey,
          from: getIntegration("EMAIL_FROM"),
          appUrl: process.env.BETTER_AUTH_URL ?? "",
        }),
      () => (apiKey ? null : "email skipped: email not set up"),
    );
  });
}
