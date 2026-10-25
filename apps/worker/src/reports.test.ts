import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { PERFORMANCE_CONFIG, REPORT_MONTHLY_QUEUE, openSharedReport } from "@opengmb/core";
import {
  auditLog,
  createDb,
  locations,
  organizations,
  performanceDaily,
  reportDefinitions,
  reportRuns,
  reportShareLinks,
  users,
  workspaces,
} from "@opengmb/db";
import type { EmailMessage } from "./digest";
import { registerReportSchedule, runMonthlyReports } from "./reports";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const NOW = new Date("2026-10-01T14:00:00Z");
const DOMAIN = `${uniq()}.example.test`;

afterAll(async () => {
  await boss.unschedule(REPORT_MONTHLY_QUEUE).catch(() => {});
  await boss.stop();
  await sql.end();
});

let orgId: string;
let monthlyId: string;
let manualId: string;
let noRecipientsId: string;

beforeAll(async () => {
  await boss.start();
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  orgId = org!.id;
  const [ws] = await db
    .insert(workspaces)
    .values({ orgId, name: `w-${uniq()}` })
    .returning();
  const userId = `u-${uniq()}`;
  await db.insert(users).values({ id: userId, name: "T", email: `${userId}@example.test` });
  const [loc] = await db
    .insert(locations)
    .values({ orgId, workspaceId: ws!.id, name: `locations/${uniq()}`, title: "Acme Dental" })
    .returning();
  await db
    .insert(performanceDaily)
    .values([{ orgId, locationId: loc!.id, date: "2026-09-10", metric: "CALL_CLICKS", value: 12 }]);
  const base = {
    orgId,
    workspaceId: ws!.id,
    scope: "workspace" as const,
    period: "last_month" as const,
    createdBy: userId,
  };
  const [m, n, r] = await db
    .insert(reportDefinitions)
    .values([
      {
        ...base,
        name: "Monthly Acme",
        schedule: "monthly",
        recipients: [`one@${DOMAIN}`, `two@${DOMAIN}`],
      },
      { ...base, name: "Manual only", schedule: "none", recipients: [`three@${DOMAIN}`] },
      { ...base, name: "No recipients", schedule: "monthly", recipients: [] },
    ])
    .returning();
  monthlyId = m!.id;
  manualId = n!.id;
  noRecipientsId = r!.id;
});

const deps = (sent: EmailMessage[], over: Record<string, unknown> = {}) => ({
  sendEmail: async (m: EmailMessage) => {
    sent.push(m);
  },
  apiKey: "re_test",
  from: "OpenGMB <notifications@ci.invalid>",
  appUrl: "https://app.test",
  now: () => NOW,
  orgIds: [orgId],
  ...over,
});
const mine = (sent: EmailMessage[]) => sent.filter((m) => m.to.endsWith(`@${DOMAIN}`));
const runsOf = (definitionId: string) =>
  db.select().from(reportRuns).where(eq(reportRuns.definitionId, definitionId));

describe("monthly report schedule", () => {
  it("registers the queues and an hourly sweep, idempotently", async () => {
    await registerReportSchedule(boss);
    await registerReportSchedule(boss);
    const schedules = await boss.getSchedules(REPORT_MONTHLY_QUEUE);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      name: REPORT_MONTHLY_QUEUE,
      cron: "0 * * * *",
      timezone: "UTC",
    });
    // The time a report is due, read in each client's zone by runMonthlyReports.
    expect(PERFORMANCE_CONFIG.monthlyReportCron).toBe("0 9 1 * *");
  });
});

describe("runMonthlyReports", () => {
  it("does nothing without an API key or sender", async () => {
    const sent: EmailMessage[] = [];
    expect(await runMonthlyReports(db, deps(sent, { apiKey: "" }))).toEqual({
      definitions: 0,
      generated: 0,
      emailed: 0,
    });
    expect(await runMonthlyReports(db, deps(sent, { from: undefined }))).toMatchObject({
      emailed: 0,
    });
    expect(sent).toHaveLength(0);
    expect(await runsOf(monthlyId)).toHaveLength(0);
  });

  it("generates last month's report and emails each recipient a share link, once per month", async () => {
    const sent: EmailMessage[] = [];
    await runMonthlyReports(db, deps(sent));
    const msgs = mine(sent);
    expect(msgs.map((m) => m.to).sort()).toEqual([`one@${DOMAIN}`, `two@${DOMAIN}`]);
    const runs = await runsOf(monthlyId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "done",
      trigger: "schedule",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
    });
    expect(runs[0]!.emailedAt).not.toBeNull();
    // Neither the manual-only nor the no-recipient definition is touched.
    expect(await runsOf(manualId)).toHaveLength(0);
    expect(await runsOf(noRecipientsId)).toHaveLength(0);

    // The emailed link opens the PDF (30-day expiry), and the mail carries a link, not review text.
    const m = msgs[0]!;
    const token = m.text.match(/https:\/\/app\.test\/r\/([A-Za-z0-9_-]{43})/)![1]!;
    const opened = await openSharedReport(db, token, NOW);
    expect(opened.status).toBe("ok");
    const [link] = await db
      .select()
      .from(reportShareLinks)
      .where(eq(reportShareLinks.reportRunId, runs[0]!.id));
    expect(link!.expiresAt.getTime() - NOW.getTime()).toBe(
      PERFORMANCE_CONFIG.monthlyEmailLinkDays * 86_400_000,
    );
    expect(m.subject).toContain("Monthly Acme");
    expect(m.html).toContain("/r/");

    // Second run the same month: nothing new.
    const again: EmailMessage[] = [];
    await runMonthlyReports(db, deps(again));
    expect(mine(again)).toHaveLength(0);
    expect(await runsOf(monthlyId)).toHaveLength(1);
    const emailedAudits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "reports.monthly_emailed")));
    expect(emailedAudits).toHaveLength(1);
    expect(JSON.stringify(emailedAudits[0]!.after)).not.toContain(DOMAIN);
  });

  it("a failed send revokes the unsent link and a retry sends once", async () => {
    await db.delete(reportRuns).where(eq(reportRuns.definitionId, monthlyId));
    const failing: EmailMessage[] = [];
    await expect(
      runMonthlyReports(
        db,
        deps(failing, {
          sendEmail: async () => {
            throw new Error("resend down");
          },
        }),
      ),
    ).rejects.toThrow(/monthly reports/);
    const [run] = await runsOf(monthlyId);
    expect(run).toMatchObject({ status: "done", emailedAt: null });
    const links = await db
      .select()
      .from(reportShareLinks)
      .where(eq(reportShareLinks.reportRunId, run!.id));
    expect(links).toHaveLength(1);
    expect(links[0]!.revokedAt).not.toBeNull();

    const sent: EmailMessage[] = [];
    await runMonthlyReports(db, deps(sent));
    expect(mine(sent)).toHaveLength(2);
    expect(await runsOf(monthlyId)).toHaveLength(1);
    const again: EmailMessage[] = [];
    await runMonthlyReports(db, deps(again));
    expect(mine(again)).toHaveLength(0);
  });
});

describe("monthly reports follow the client's time zone", () => {
  it("a Kolkata client is due on the 1st at 09:00 IST (03:30Z), not at 09:00Z; the period is the local last month", async () => {
    const [w] = await db
      .insert(workspaces)
      .values({ orgId, name: `ist-${uniq()}`, timeZone: "Asia/Kolkata" })
      .returning();
    const userId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
    const [d] = await db
      .insert(reportDefinitions)
      .values({
        orgId,
        workspaceId: w!.id,
        scope: "workspace",
        period: "last_month",
        createdBy: userId,
        name: "IST monthly",
        schedule: "monthly",
        recipients: [`ist@${DOMAIN}`],
      })
      .returning();
    const at = (iso: string) => ({ now: () => new Date(iso) });
    // 03:29Z on 1 Oct is 08:59 IST: not due yet
    const early: EmailMessage[] = [];
    await runMonthlyReports(db, deps(early, at("2026-10-01T03:29:00Z")));
    expect(mine(early).filter((m) => m.to === `ist@${DOMAIN}`)).toHaveLength(0);
    expect(await runsOf(d!.id)).toHaveLength(0);
    // 03:30Z on 1 Oct: 09:00 IST, due, for September
    const due: EmailMessage[] = [];
    await runMonthlyReports(db, deps(due, at("2026-10-01T03:30:00Z")));
    expect(mine(due).filter((m) => m.to === `ist@${DOMAIN}`)).toHaveLength(1);
    expect((await runsOf(d!.id))[0]).toMatchObject({ periodStart: "2026-09-01", periodEnd: "2026-09-30" });
    // 31 Oct 20:00Z is 1 Nov 01:30 IST: the 1st locally but before 09:00 local; UTC is still the 31st
    const edge: EmailMessage[] = [];
    await runMonthlyReports(db, deps(edge, at("2026-10-31T20:00:00Z")));
    expect(mine(edge).filter((m) => m.to === `ist@${DOMAIN}`)).toHaveLength(0);
  });
});
