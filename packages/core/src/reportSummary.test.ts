import { inflateSync } from "node:zlib";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { aiUsage, auditLog, reportRuns } from "@opengmb/db";
import type { Actor } from "./actor";
import { setAiTestOverrides, type AiModel } from "./ai/model";
import { costMicroUsd } from "./ai/money";
import { withMarkupMicro } from "./billing";
import { AI_DEFAULTS } from "./config/ai-models";
import { REPORT_SUMMARY } from "./config/report-summary";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { db, makeOrg, putDaily, sql, type Org } from "./performance-fixture";
import { createShareLink, viewSharedReport } from "./reports/share";
import { REPORT_GENERATE_QUEUE, processReportRun } from "./reports/run";
import {
  checkSummary,
  numbersIn,
  performancePrompt,
  reviewPrompt,
  summaryMaxChargeMicroUsd,
  summaryMaxCostMicroUsd,
  unknownNumbers,
} from "./reports/summary";
import type { ReviewStats } from "./reviews/stats";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
const boss = new PgBoss(process.env.DATABASE_URL_TEST!);
const NOW = new Date("2026-10-12T14:00:00Z");
const run = (actor: Actor, name: string, input: unknown = {}) => executeAction(db, actor, name, input);

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
  for (const c of chunks) for (const h of c.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(h[1]!, "hex").toString("latin1"));
  return out.join("\n");
}

const GOOD = "Calls rose from 5 to 10, up 100%. Impressions on Maps held at 100. Next, ask recent customers for a review.";
let o: Org;
beforeAll(async () => {
  await boss.start();
  await boss.createQueue(REPORT_GENERATE_QUEUE);
  o = await makeOrg();
  await putDaily(o.orgId, o.locA1.id, [
    ["2026-09-08", "CALL_CLICKS", 10],
    ["2026-08-10", "CALL_CLICKS", 5],
    ["2026-09-09", "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", 100],
    ["2026-08-11", "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", 100],
  ]);
});
afterAll(async () => {
  setAiTestOverrides({});
  await boss.stop();
  await sql.end();
});

const calls: { system: string; user: string }[] = [];
const answering = (text: string): AiModel => async (req) => {
  calls.push({ system: req.system, user: req.user });
  return { text, inputTokens: 700, outputTokens: 90 };
};
const useModel = (m: AiModel, env: Record<string, string> = {}) =>
  setAiTestOverrides({ model: m, env: { AI_MONTHLY_BUDGET_USD: "1000", ...env } });
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", () => {
    throw new Error("the real network must never be reached in tests");
  });
});

const newDef = (over: Record<string, unknown> = {}) => ({
  workspaceId: o.wsA,
  name: "Monthly numbers",
  scope: "workspace",
  locationIds: [],
  period: "custom",
  customFrom: "2026-09-01",
  customTo: "2026-09-30",
  schedule: "none",
  recipients: [],
  branding: { agencyName: "Synectus Agency" },
  ...over,
});
async function generate(over: Record<string, unknown> = {}) {
  const d = (await run(o.manager, "reports.definitions.create", newDef(over))) as { definition: { id: string; aiSummary: boolean } };
  const r = (await run(o.manager, "reports.generate", { definitionId: d.definition.id })) as { runId: string };
  const outcome = await processReportRun(db, r.runId, { now: NOW });
  const [row] = await db.select().from(reportRuns).where(eq(reportRuns.id, r.runId));
  return { def: d.definition, runId: r.runId, outcome, row: row! };
}
const usageRows = (action = "reports.summary") =>
  db.select().from(aiUsage).where(and(eq(aiUsage.orgId, o.orgId), eq(aiUsage.action, action)));

describe("the check on the answer", () => {
  const data = "Calls: 10; 5; +100%\nImpressions: 1,200; 1000; +20%\nAverage rating: 4.5";
  it("canary: a number that is not in the input is found", () => {
    expect(unknownNumbers("Calls rose to 99.", data)).toEqual([99]);
    expect(unknownNumbers("Calls rose to 10, up 100%.", data)).toEqual([]);
  });
  it("accepts a number the input holds with a thousands comma, and a rounding of one it holds", () => {
    expect(unknownNumbers("Impressions reached 1,200.", data)).toEqual([]);
    expect(unknownNumbers("The rating is about 5.", data)).toEqual([]);
    expect(unknownNumbers("The rating is 4.6.", data)).toEqual([4.6]);
    expect(numbersIn("1,200 and 3.5%")).toEqual([1200, 3.5]);
  });
  it("rejects an answer with an invented number, an empty one, a long one and one the PDF cannot print", () => {
    expect(checkSummary("Calls rose to 10.", data)).toBe("Calls rose to 10.");
    expect(checkSummary("Calls rose to 11.", data)).toBeNull();
    expect(checkSummary("   ", data)).toBeNull();
    expect(checkSummary("a ".repeat(REPORT_SUMMARY.maxChars), data)).toBeNull();
    expect(checkSummary("Calls rose to 10 \u{1F600}.", data)).toBeNull();
  });
  it("normalises dashes and quotes and joins lines into one paragraph", () => {
    expect(checkSummary("Calls rose — to 10.\n\nIt’s good.", data)).not.toMatch(/—|’|\n/);
  });
});

describe("the prompt holds only the computed numbers", () => {
  const stats: ReviewStats = {
    newReviews: 4, previousNewReviews: 2, averageRating: 4.25, previousAverageRating: null, replyRate: 0.5,
    previousReplyRate: 0.25, medianHoursToReply: 5, starMix: [0, 0, 1, 1, 2], trend: [],
    byLocation: [
      { locationId: "l1", label: "Acme Dental", newReviews: 3, averageRating: 4.5, replyRate: 0.5, medianHoursToReply: 5 },
      { locationId: "l2", label: "Acme North", newReviews: 1, averageRating: 4, replyRate: null, medianHoursToReply: null },
    ],
  };
  it("review prompt: counts, ratings and times; nothing else, and a rule against other numbers", () => {
    const p = reviewPrompt({ periodStart: "2026-09-01", periodEnd: "2026-09-30", previousFrom: "2026-08-02", previousTo: "2026-08-31", locationCount: 2, stats, language: "en" });
    expect(p.user).toContain("New reviews: 4; previous period: 2");
    expect(p.user).toContain("Reply rate: 50%; previous period: 25%");
    expect(p.user).toContain("- Acme Dental: 3 new, average 4.5");
    expect(p.system).toMatch(/Never write a number that is not in the data/);
    expect(p.system).toMatch(/3 to 5 plain sentences/);
    // The instructions' own numbers are not part of the data the answer is checked against.
    expect(p.user).not.toMatch(/sentences/);
  });
  it("language goes in the system prompt only", () => {
    const base = { periodStart: "2026-09-01", periodEnd: "2026-09-30", previousFrom: "2026-08-02", previousTo: "2026-08-31", locationCount: 1, summary: { kpis: [] }, keywords: [] };
    expect(performancePrompt({ ...base, language: "es" }).system).toContain("Write in Spanish");
    expect(performancePrompt({ ...base, language: "en" }).user).toBe(performancePrompt({ ...base, language: "es" }).user);
  });
  it("the price comes from the model's configured prices", () => {
    const tokens = Math.ceil(REPORT_SUMMARY.typicalPromptChars / AI_DEFAULTS.charsPerToken);
    expect(summaryMaxCostMicroUsd()).toBe(costMicroUsd(AI_DEFAULTS.model, tokens, REPORT_SUMMARY.maxOutputTokens));
    expect(summaryMaxChargeMicroUsd()).toBe(withMarkupMicro(summaryMaxCostMicroUsd()));
    expect(summaryMaxChargeMicroUsd()).toBeGreaterThan(0);
  });
});

describe("a report with the summary on", () => {
  it("is off by default: no model call, no summary, no usage", async () => {
    useModel(answering(GOOD));
    const g = await generate();
    expect(g.def.aiSummary).toBe(false);
    expect(g.outcome).toBe("done");
    expect(calls).toHaveLength(0);
    expect(g.row.summary).toBeNull();
    expect(g.row.summaryStatus).toBeNull();
    expect(pdfText(g.row.pdf!)).not.toContain("Summary");
  });

  it("writes one summary from the numbers, stores it, and shows the same text in the PDF and on the share page", async () => {
    useModel(answering(GOOD));
    const before = (await usageRows()).length;
    const g = await generate({ aiSummary: true });
    expect(g.outcome).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user).toContain("Calls: 10; 5; +100%");
    expect(calls[0]!.user).not.toContain("Monthly numbers");
    expect(g.row.summary).toBe(GOOD);
    expect(g.row.summaryStatus).toBe("written");
    const text = pdfText(g.row.pdf!);
    expect(text).toContain("Summary");
    expect(text).toContain("Calls rose from 5 to 10, up 100%.");

    const usage = await usageRows();
    expect(usage).toHaveLength(before + 1);
    expect(usage.at(-1)).toMatchObject({ model: AI_DEFAULTS.model, purpose: "report_summary", userId: null, workspaceId: o.wsA });

    const link = await db.transaction((tx) => createShareLink(tx, { orgId: o.orgId, reportRunId: g.runId, createdBy: null, expiresInDays: 7, now: NOW }));
    const view = await viewSharedReport(db, link.token, NOW);
    expect(view.status === "ok" && view.summary).toBe(GOOD);

    // The audit row carries ids, counts and cost, never the text.
    const audits = (await db.select().from(auditLog).where(eq(auditLog.orgId, o.orgId))).filter((a) => a.action === "reports.summary" && a.entityId === g.runId);
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.after)).not.toContain("Calls rose");
    expect(audits[0]!.after).toMatchObject({ status: "written" });
  });

  it("a retried job reuses the stored summary: the model is not called, and not paid for, twice", async () => {
    useModel(answering(GOOD));
    const g = await generate({ aiSummary: true });
    expect(calls).toHaveLength(1);
    const usage = (await usageRows()).length;
    await db.update(reportRuns).set({ status: "queued" }).where(eq(reportRuns.id, g.runId));
    expect(await processReportRun(db, g.runId, { now: NOW })).toBe("done");
    expect(calls).toHaveLength(1);
    expect((await usageRows()).length).toBe(usage);
    const [row] = await db.select().from(reportRuns).where(eq(reportRuns.id, g.runId));
    expect(row!.summary).toBe(GOOD);
    expect(pdfText(row!.pdf!)).toContain("Calls rose from 5 to 10");
  });

  it("canary: an answer with a number that is not in the input is thrown away, the report still finishes, and the call is still counted", async () => {
    useModel(answering("Calls rose to 99 this month."));
    const before = (await usageRows()).length;
    const g = await generate({ aiSummary: true });
    expect(g.outcome).toBe("done");
    expect(g.row.status).toBe("done");
    expect(g.row.summary).toBeNull();
    expect(g.row.summaryStatus).toBe("rejected");
    expect(pdfText(g.row.pdf!)).not.toContain("99");
    expect((await usageRows()).length).toBe(before + 1);
  });

  it.each([
    ["AI is off", () => setAiTestOverrides({ env: {} }), "ai_off"],
    ["the platform limit is reached", () => useModel(answering(GOOD), { AI_MONTHLY_BUDGET_USD: "0" }), "over_cap"],
    ["the AI service fails", () => useModel(async () => { throw new CoreError("CONFLICT", "The AI service could not be reached. Try again."); }), "ai_error"],
  ])("the report is made without a summary when %s", async (_n, setup, status) => {
    setup();
    const before = (await usageRows()).length;
    const g = await generate({ aiSummary: true });
    expect(g.outcome).toBe("done");
    expect(g.row.summary).toBeNull();
    expect(g.row.summaryStatus).toBe(status);
    expect(g.row.error).toBeNull();
    expect((await usageRows()).length).toBe(before);
    expect(pdfText(g.row.pdf!)).toContain("Key results");
  });

  it("a review report gets a summary too, in the review PDF", async () => {
    useModel(answering("There were no new reviews in this period, so there is nothing to compare."));
    const g = await generate({ kind: "reviews", aiSummary: true, language: "en" });
    expect(g.outcome).toBe("done");
    expect(calls[0]!.user).toContain("New reviews: 0; previous period: 0");
    expect(g.row.summaryStatus).toBe("written");
    expect(pdfText(g.row.pdf!)).toContain("Summary");
  });

  it("the option can be turned on and off through the update action, and a client viewer cannot", async () => {
    const d = (await run(o.manager, "reports.definitions.create", newDef())) as { definition: { id: string } };
    const on = (await run(o.manager, "reports.definitions.update", { id: d.definition.id, aiSummary: true })) as { definition: { aiSummary: boolean } };
    expect(on.definition.aiSummary).toBe(true);
    const off = (await run(o.manager, "reports.definitions.update", { id: d.definition.id, aiSummary: false })) as { definition: { aiSummary: boolean } };
    expect(off.definition.aiSummary).toBe(false);
    await expect(run(o.viewerA, "reports.definitions.update", { id: d.definition.id, aiSummary: true })).rejects.toThrow(/lacks report:manage/);
  });
});
