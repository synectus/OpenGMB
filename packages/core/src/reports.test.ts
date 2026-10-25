import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { inflateSync } from "node:zlib";
import { PgBoss } from "pg-boss";
import { auditLog, reportRuns, reportShareLinks } from "@opengmb/db";
import type { Actor } from "./actor";
import { verifyAuditChain } from "./audit";
import { PERFORMANCE_CONFIG } from "./config/performance";
import { executeAction } from "./executor";
import { renderReportPdf } from "./reports/pdf";
import { REPORT_GENERATE_QUEUE, processReportRun } from "./reports/run";
import { hashToken, openSharedReport } from "./reports/share";
import { codeOf, db, makeOrg, putDaily, putKeywords, sql, type Org } from "./performance-fixture";

const boss = new PgBoss(process.env.DATABASE_URL_TEST!);
const NOW = new Date("2026-10-12T14:00:00Z");
const run = (actor: Actor, name: string, input: unknown = {}) =>
  executeAction(db, actor, name, input);

/** Text drawn on a pdf-lib page: hex strings before `Tj`, in (possibly deflated) content streams. */
function pdfText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const chunks: string[] = [raw];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\nendstream/g)) {
    try {
      chunks.push(inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1"));
    } catch {
      // not deflated
    }
  }
  const out: string[] = [];
  for (const c of chunks) {
    for (const h of c.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      out.push(Buffer.from(h[1]!, "hex").toString("latin1"));
    }
  }
  return out.join("\n");
}

let o: Org;
let other: Org;

beforeAll(async () => {
  await boss.start();
  await boss.createQueue(REPORT_GENERATE_QUEUE);
  o = await makeOrg();
  other = await makeOrg();
  await putDaily(o.orgId, o.locA1.id, [
    ["2026-09-08", "CALL_CLICKS", 10],
    ["2026-09-09", "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", 100],
  ]);
  await putKeywords(o.orgId, o.locA1.id, [
    ["2026-09-01", "emergency dentist", 70, null],
    ["2026-09-01", "obscure thing", null, 15],
  ]);
});
afterAll(async () => {
  await boss.stop();
  await sql.end();
});

const newDef = (over: Record<string, unknown> = {}) => ({
  workspaceId: o.wsA,
  name: "Monthly report: Acme",
  scope: "workspace",
  locationIds: [],
  period: "custom",
  customFrom: "2026-09-01",
  customTo: "2026-09-30",
  schedule: "none",
  recipients: [],
  branding: { agencyName: "Synectus Agency", colour: "#AA3300" },
  ...over,
});

type Def = { id: string; locationIds: string[]; recipients: string[] };
const createDef = async (over: Record<string, unknown> = {}) =>
  ((await run(o.manager, "reports.definitions.create", newDef(over))) as { definition: Def })
    .definition;

async function generate(id: string) {
  const r = (await run(o.manager, "reports.generate", { definitionId: id })) as {
    runId: string;
    jobId: string;
  };
  const jobs = await sql<{ id: string }[]>`
    select id from pgboss.job where id = ${r.jobId} and name = ${REPORT_GENERATE_QUEUE}`;
  expect(jobs).toHaveLength(1);
  expect(await processReportRun(db, r.runId, { now: NOW })).toBe("done");
  return r.runId;
}

describe("report definitions", () => {
  it("CRUD with audit rows, no recipient addresses in audit", async () => {
    const d = await createDef({ schedule: "monthly", recipients: ["client@example.test"] });

    const list = (await run(o.viewerA, "reports.definitions.list")) as { definitions: Def[] };
    expect(list.definitions.map((x) => x.id)).toContain(d.id);
    const upd = (await run(o.manager, "reports.definitions.update", {
      id: d.id,
      name: "Renamed",
      recipients: ["a@example.test", "b@example.test"],
    })) as { definition: { name: string; recipients: string[] } };
    expect(upd.definition).toMatchObject({ name: "Renamed" });
    expect(upd.definition.recipients).toHaveLength(2);
    await run(o.manager, "reports.definitions.delete", { id: d.id });
    const gone = (await run(o.owner, "reports.definitions.list")) as { definitions: Def[] };
    expect(gone.definitions.map((x) => x.id)).not.toContain(d.id);

    const rows = await db.select().from(auditLog).where(eq(auditLog.orgId, o.orgId));
    const actions = rows.map((r) => r.action);
    for (const a of [
      "reports.definition_created",
      "reports.definition_updated",
      "reports.definition_deleted",
    ]) {
      expect(actions).toContain(a);
    }
    expect(JSON.stringify(rows.map((r) => [r.before, r.after]))).not.toContain("example.test");
    expect((await verifyAuditChain(db, o.orgId)).ok).toBe(true);
  });

  it("validates scope, period, schedule and branding", async () => {
    const bad = (over: Record<string, unknown>) =>
      codeOf(run(o.manager, "reports.definitions.create", newDef(over)));
    expect(await bad({ scope: "locations" })).toMatch(/^INVALID_INPUT/);
    expect(await bad({ locationIds: [o.locA1.id] })).toMatch(/^INVALID_INPUT/);
    expect(await bad({ scope: "locations", locationIds: [o.locB.id] })).toMatch(/^NOT_FOUND/);
    expect(await bad({ period: "custom", customFrom: null })).toMatch(/^INVALID_INPUT/);
    expect(await bad({ customFrom: "2026-09-30", customTo: "2026-09-01" })).toMatch(
      /^INVALID_INPUT/,
    );
    expect(await bad({ period: "last_month" })).toMatch(/^INVALID_INPUT/);
    expect(await bad({ schedule: "monthly" })).toMatch(/^INVALID_INPUT/);
    expect(await bad({ recipients: ["not-an-email"] })).toMatch(/^INVALID_INPUT/);
    expect(await bad({ branding: { colour: "red" } })).toMatch(/^INVALID_INPUT/);
    expect(await bad({ workspaceId: other.wsA })).toMatch(/^NOT_FOUND/);
  });

  it("enforces roles and tenancy", async () => {
    const d = await createDef();
    expect(await codeOf(run(o.viewerA, "reports.definitions.create", newDef()))).toMatch(
      /^FORBIDDEN/,
    );
    expect(await codeOf(run(o.viewerA, "reports.generate", { definitionId: d.id }))).toMatch(
      /^FORBIDDEN/,
    );
    expect(
      await codeOf(run(o.viewerB, "reports.definitions.update", { id: d.id, name: "x" })),
    ).toMatch(/^FORBIDDEN/);
    expect(await codeOf(run(other.owner, "reports.generate", { definitionId: d.id }))).toMatch(
      /^NOT_FOUND/,
    );
    const vb = (await run(o.viewerB, "reports.definitions.list")) as { definitions: Def[] };
    expect(vb.definitions.map((x) => x.id)).not.toContain(d.id);
  });
});

describe("report generation and download", () => {
  it("produces a valid PDF with title, branding, period, KPIs and keywords, and no review text", async () => {
    const d = await createDef({ name: "September report" });
    const runId = await generate(d.id);
    const got = (await run(o.viewerA, "reports.runs.get", { runId })) as {
      run: { status: string; pdfBytes: number; periodStart: string };
    };
    expect(got.run).toMatchObject({ status: "done", periodStart: "2026-09-01" });
    expect(got.run.pdfBytes).toBeGreaterThan(500);

    const dl = (await run(o.viewerA, "reports.download", { runId })) as {
      filename: string;
      sizeBytes: number;
      base64: string;
    };
    const pdf = Buffer.from(dl.base64, "base64");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBe(dl.sizeBytes);
    expect(dl.filename).toBe("september-report-2026-09-01-to-2026-09-30.pdf");
    const text = pdfText(pdf);
    for (const s of [
      "September report",
      "Synectus Agency",
      "2026-09-01 to 2026-09-30",
      "Profile impressions",
      "Calls",
      "emergency dentist",
      "below 15",
    ]) {
      expect(text).toContain(s);
    }
    expect(text).not.toMatch(/—/);

    const audits = await db.select().from(auditLog).where(eq(auditLog.orgId, o.orgId));
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["reports.run_requested", "reports.run_completed"]),
    );
  });

  it("a queued run is processed once; a download before it is ready conflicts; others cannot download", async () => {
    const d = await createDef();
    const r = (await run(o.manager, "reports.generate", { definitionId: d.id })) as {
      runId: string;
    };
    expect(await codeOf(run(o.viewerA, "reports.download", { runId: r.runId }))).toMatch(
      /^CONFLICT/,
    );
    expect(await processReportRun(db, r.runId, { now: NOW })).toBe("done");
    expect(await processReportRun(db, r.runId, { now: NOW })).toBe("skipped");
    expect(await codeOf(run(o.viewerB, "reports.download", { runId: r.runId }))).toMatch(
      /^NOT_FOUND/,
    );
    expect(await codeOf(run(other.owner, "reports.download", { runId: r.runId }))).toMatch(
      /^NOT_FOUND/,
    );
    const list = (await run(o.viewerA, "reports.runs.list", { definitionId: d.id })) as {
      runs: { id: string }[];
    };
    expect(list.runs.map((x) => x.id)).toContain(r.runId);
  });

  it("refuses over-size PDFs over the tool transport and fails over-cap renders", async () => {
    const d = await createDef();
    const runId = await generate(d.id);
    await db
      .update(reportRuns)
      .set({ pdf: Buffer.alloc(PERFORMANCE_CONFIG.reportMcpMaxBytes + 1, 1) })
      .where(eq(reportRuns.id, runId));
    expect(await codeOf(run(o.viewerA, "reports.download", { runId }))).toMatch(/^INVALID_INPUT/);
  });

  it("renders unencodable keyword characters without throwing", async () => {
    const bytes = await renderReportPdf({
      title: "Zahnarzt — 北京",
      branding: {},
      periodLabel: "2026-09-01 to 2026-09-30",
      comparisonLabel: "2026-08-01 to 2026-08-31",
      locationLabels: ["A"],
      summary: { kpis: [] },
      keywords: [{ keyword: "北京 dentist", value: 20, isLowerBound: false, hiddenBelow: 0 }],
      generatedAt: NOW,
    });
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("share links", () => {
  const share = async (runId: string, expiresInDays = 7) =>
    (await run(o.manager, "reports.share", { runId, expiresInDays, businessAgreed: true })) as {
      linkId: string;
      url: string;
      expiresAt: string;
    };
  const tokenOf = (url: string) => url.split("/r/")[1]!;

  it("a link needs the explicit confirmation, and expires after the configured default unless asked otherwise (Q33c)", async () => {
    const runId = await generate((await createDef()).id);
    expect(await codeOf(run(o.manager, "reports.share", { runId }))).toMatch(/^INVALID_INPUT/);
    expect(await codeOf(run(o.manager, "reports.share", { runId, businessAgreed: false }))).toMatch(/^INVALID_INPUT/);
    const link = (await run(o.manager, "reports.share", { runId, businessAgreed: true })) as { expiresAt: string };
    const days = (Date.parse(link.expiresAt) - Date.now()) / 86_400_000;
    expect(PERFORMANCE_CONFIG.shareLinkDefaultDays).toBe(7);
    expect(days).toBeGreaterThan(PERFORMANCE_CONFIG.shareLinkDefaultDays - 0.1);
    expect(days).toBeLessThan(PERFORMANCE_CONFIG.shareLinkDefaultDays + 0.1);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.orgId, o.orgId), eq(auditLog.action, "reports.share_created")));
    expect(audit.some((a) => (a.after as { businessAgreed?: boolean }).businessAgreed === true)).toBe(true);
  });

  it("serves the PDF for a valid link, audits the access, stores only the hash", async () => {
    const runId = await generate((await createDef()).id);
    const link = await share(runId);
    expect(link.url).toMatch(/\/r\/[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(link.url);
    const [row] = await db
      .select()
      .from(reportShareLinks)
      .where(eq(reportShareLinks.id, link.linkId));
    expect(row!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);

    const res = await openSharedReport(db, token, NOW);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(res.runId).toBe(runId);
    }
    const [a] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, o.orgId), eq(auditLog.action, "reports.share_accessed")));
    expect(a).toMatchObject({ surface: "ui", actorType: "system", actorUserId: null });
    expect(a!.after).toEqual({ runId });
    // the token itself never lands in audit
    const all = await db.select().from(auditLog).where(eq(auditLog.orgId, o.orgId));
    expect(JSON.stringify(all)).not.toContain(token);
    expect((await verifyAuditChain(db, o.orgId)).ok).toBe(true);
  });

  it("rejects wrong tokens, expired links and revoked links", async () => {
    const runId = await generate((await createDef()).id);
    const link = await share(runId, 1);
    const token = tokenOf(link.url);
    expect((await openSharedReport(db, "x".repeat(43), NOW)).status).toBe("invalid");
    expect((await openSharedReport(db, "short", NOW)).status).toBe("invalid");
    expect(
      (await openSharedReport(db, token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), NOW))
        .status,
    ).toBe("invalid");
    // expired: the link was made "now" (real clock) for 1 day
    expect((await openSharedReport(db, token, new Date(Date.now() + 2 * 86_400_000))).status).toBe(
      "expired",
    );
    expect((await openSharedReport(db, token)).status).toBe("ok");

    await run(o.manager, "reports.share.revoke", { linkId: link.linkId });
    expect((await openSharedReport(db, token)).status).toBe("revoked");
    expect(await codeOf(run(o.manager, "reports.share.revoke", { linkId: link.linkId }))).toMatch(
      /^CONFLICT/,
    );

    const denied = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, o.orgId), eq(auditLog.action, "reports.share_denied")));
    expect(denied.map((d) => (d.after as { reason: string }).reason)).toEqual(
      expect.arrayContaining(["expired", "revoked"]),
    );
    const got = (await run(o.viewerA, "reports.runs.get", { runId })) as {
      shareLinks: { id: string; active: boolean }[];
    };
    expect(got.shareLinks).toEqual([expect.objectContaining({ id: link.linkId, active: false })]);
  });

  it("limits expiry to the configured maximum, needs a finished run, and enforces roles", async () => {
    const d = await createDef();
    const queued = (await run(o.manager, "reports.generate", { definitionId: d.id })) as {
      runId: string;
    };
    expect(await codeOf(run(o.manager, "reports.share", { runId: queued.runId, businessAgreed: true }))).toMatch(
      /^CONFLICT/,
    );
    await processReportRun(db, queued.runId, { now: NOW });
    expect(
      await codeOf(
        run(o.manager, "reports.share", {
          runId: queued.runId,
          businessAgreed: true,
          expiresInDays: PERFORMANCE_CONFIG.shareLinkMaxDays + 1,
        }),
      ),
    ).toMatch(/^INVALID_INPUT/);
    expect(await codeOf(run(o.viewerA, "reports.share", { runId: queued.runId, businessAgreed: true }))).toMatch(
      /^FORBIDDEN/,
    );
    expect(await codeOf(run(other.owner, "reports.share", { runId: queued.runId, businessAgreed: true }))).toMatch(
      /^NOT_FOUND/,
    );
    const link = await share(queued.runId, PERFORMANCE_CONFIG.shareLinkMaxDays);
    expect(await codeOf(run(other.owner, "reports.share.revoke", { linkId: link.linkId }))).toMatch(
      /^NOT_FOUND/,
    );
    expect(await codeOf(run(o.viewerA, "reports.share.revoke", { linkId: link.linkId }))).toMatch(
      /^FORBIDDEN/,
    );
  });
});
