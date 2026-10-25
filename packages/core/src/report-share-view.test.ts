import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { auditLog, orgBranding, reportRuns, reportShareLinks } from "@opengmb/db";
import type { Actor } from "./actor";
import { verifyAuditChain } from "./audit";
import { executeAction } from "./executor";
import { parseRunContent } from "./reports/content";
import { REPORT_GENERATE_QUEUE, processReportRun } from "./reports/run";
import { openSharedReport, viewSharedReport } from "./reports/share";
import { db, makeOrg, putDaily, putKeywords, sql, type Org } from "./performance-fixture";

const boss = new PgBoss(process.env.DATABASE_URL_TEST!);
const NOW = new Date("2026-10-12T14:00:00Z");
const run = (actor: Actor, name: string, input: unknown = {}) => executeAction(db, actor, name, input);
const tokenOf = (url: string) => url.split("/r/")[1]!;

let o: Org;

async function sharedRun(over: Record<string, unknown> = {}, days = 7) {
  const d = (await run(o.manager, "reports.definitions.create", {
    workspaceId: o.wsA,
    name: "Monthly performance",
    scope: "workspace",
    locationIds: [],
    period: "custom",
    customFrom: "2026-09-01",
    customTo: "2026-09-30",
    schedule: "none",
    recipients: [],
    branding: { agencyName: "Synectus Agency", colour: "#AA3300" },
    comment: "Calls grew again in September.",
    ...over,
  })) as { definition: { id: string } };
  const g = (await run(o.manager, "reports.generate", { definitionId: d.definition.id })) as { runId: string };
  expect(await processReportRun(db, g.runId, { now: NOW })).toBe("done");
  const link = (await run(o.manager, "reports.share", { runId: g.runId, expiresInDays: days, businessAgreed: true })) as {
    linkId: string;
    url: string;
  };
  return { runId: g.runId, linkId: link.linkId, token: tokenOf(link.url) };
}

const audits = (action: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.orgId, o.orgId), eq(auditLog.action, action)))
    .orderBy(auditLog.id);

beforeAll(async () => {
  await boss.start();
  await boss.createQueue(REPORT_GENERATE_QUEUE);
  o = await makeOrg();
  await putDaily(o.orgId, o.locA1.id, [
    ["2026-09-08", "CALL_CLICKS", 12],
    ["2026-08-20", "CALL_CLICKS", 10],
    ["2026-09-09", "BUSINESS_IMPRESSIONS_MOBILE_MAPS", 100],
  ]);
  await putKeywords(o.orgId, o.locA1.id, [
    ["2026-09-01", "emergency dentist", 70, null],
    ["2026-09-01", "obscure thing", null, 15],
  ]);
  await db.insert(orgBranding).values({
    orgId: o.orgId,
    agencyName: "Org Agency",
    logoUrl: "https://logo.example.test/mark.png",
    primaryColor: "#1d4ed8",
  });
});
afterAll(async () => {
  await boss.stop();
  await sql.end();
});

describe("run content snapshot", () => {
  it("is stored with the PDF and holds what the PDF showed", async () => {
    const { runId } = await sharedRun();
    const [row] = await db.select().from(reportRuns).where(eq(reportRuns.id, runId));
    const c = parseRunContent(row!.content);
    expect(c).not.toBeNull();
    expect(c).toMatchObject({
      v: 1,
      title: "Monthly performance",
      periodLabel: "September 2026",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      previousFrom: "2026-08-02",
      previousTo: "2026-08-31",
      workspaceName: "A",
      locationCount: 3,
      language: "en",
      comment: "Calls grew again in September.",
      branding: { agencyName: "Synectus Agency", colour: "#AA3300" },
      keywordMonths: ["2026-09"],
    });
    expect(c!.kpis.find((k) => k.key === "calls")).toMatchObject({ total: 12, previousTotal: 10 });
    expect(c!.keywords.map((k) => k.keyword)).toEqual(["emergency dentist", "obscure thing"]);
  });

  it("parseRunContent returns null for old runs and malformed json", () => {
    expect(parseRunContent(null)).toBeNull();
    expect(parseRunContent({ v: 2 })).toBeNull();
  });
});

describe("viewSharedReport", () => {
  it("returns the snapshot and brand for a valid link, audits the view, never the token", async () => {
    const { runId, token } = await sharedRun();
    const v = await viewSharedReport(db, token, NOW);
    expect(v.status).toBe("ok");
    if (v.status !== "ok") return;
    expect(v).toMatchObject({ runId, title: "Monthly performance", periodLabel: "September 2026" });
    expect(v.pdfBytes).toBeGreaterThan(500);
    expect(v.content?.comment).toBe("Calls grew again in September.");
    expect(v.brand).toEqual({
      agencyName: "Synectus Agency",
      colour: "#AA3300",
      logoUrl: "https://logo.example.test/mark.png",
    });
    expect(v).not.toHaveProperty("pdf");
    const viewed = await audits("reports.share_viewed");
    expect(viewed.at(-1)).toMatchObject({ surface: "ui", actorType: "system", actorUserId: null });
    expect(viewed.at(-1)!.after).toEqual({ runId });
    const all = await db.select().from(auditLog).where(eq(auditLog.orgId, o.orgId));
    expect(JSON.stringify(all)).not.toContain(token);
    expect((await verifyAuditChain(db, o.orgId)).ok).toBe(true);
  });

  it("falls back to the org brand when the definition set none", async () => {
    const { token } = await sharedRun({ branding: {} });
    const v = await viewSharedReport(db, token, NOW);
    expect(v.status === "ok" && v.brand).toEqual({
      agencyName: "Org Agency",
      colour: "#1d4ed8",
      logoUrl: "https://logo.example.test/mark.png",
    });
  });

  it("expired and revoked links return the brand only, audited as page denials", async () => {
    const { token, linkId, runId } = await sharedRun({}, 1);
    const later = new Date(Date.now() + 2 * 86_400_000);
    const exp = await viewSharedReport(db, token, later);
    expect(exp).toEqual({ status: "expired", brand: expect.objectContaining({ agencyName: "Synectus Agency" }) });
    await run(o.manager, "reports.share.revoke", { linkId });
    const rev = await viewSharedReport(db, token);
    expect(rev.status).toBe("revoked");
    expect(rev).not.toHaveProperty("content");
    const denied = (await audits("reports.share_denied")).filter(
      (a) => (a.after as { runId: string }).runId === runId,
    );
    expect(denied.map((d) => d.after)).toEqual([
      { runId, reason: "expired", view: "page" },
      { runId, reason: "revoked", view: "page" },
    ]);
  });

  it("unknown and malformed tokens reveal nothing and write nothing; not-ready reveals nothing", async () => {
    // No org is known for an unknown token, so there is nothing to count it against; other test
    // files write audit rows to the same database in parallel, so a global row count would be
    // flaky. The code returns before writeAudit on this path (Task 2), which the review checks.
    expect(await viewSharedReport(db, "A".repeat(43), NOW)).toEqual({ status: "invalid" });
    expect(await viewSharedReport(db, "short", NOW)).toEqual({ status: "invalid" });

    const { runId, token } = await sharedRun();
    await db.update(reportRuns).set({ status: "running" }).where(eq(reportRuns.id, runId));
    expect(await viewSharedReport(db, token, NOW)).toEqual({ status: "not_ready" });
  });

  it("an old run without a snapshot still shows its title and period", async () => {
    const { runId, token } = await sharedRun();
    await db.update(reportRuns).set({ content: null }).where(eq(reportRuns.id, runId));
    const v = await viewSharedReport(db, token, NOW);
    expect(v).toMatchObject({ status: "ok", content: null, title: "Monthly performance", periodLabel: "September 2026" });
  });

  it("the PDF path is unchanged", async () => {
    const { runId, token } = await sharedRun();
    const r = await openSharedReport(db, token, NOW);
    expect(r.status === "ok" && r.runId).toBe(runId);
    const [link] = await db.select().from(reportShareLinks).where(eq(reportShareLinks.reportRunId, runId));
    expect(link).toBeTruthy();
  });
});
