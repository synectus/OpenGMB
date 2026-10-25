import { afterAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { aiVisibilityResults, aiVisibilityRuns, aiVisibilitySettings, auditLog, createDb, orgGridSettings, platformDfsSpend } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { monthToDateUsd } from "./geogrid/cost";
import { DfsAccountError } from "./geogrid/drivers/errors";
import { AI_ENGINES, AI_VISIBILITY } from "./config/ai-visibility";
import { aiVisibilityOverview } from "./ai-visibility/read";
import { checkEstimate, enqueueDueAiVisibilityChecks, runAiVisibilityCheck } from "./ai-visibility/run";
import { fixtureAiTransport, type AiTransport } from "./ai-visibility/transport";
import { makeKit } from "./testkit";

// K5: a weekly check stores what each engine answered, charged like the other paid DataForSEO features. No live calls.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

async function enabledLocation(engines: string[] = [...AI_ENGINES]) {
  const org = await kit.makeOrg();
  const loc = await org.mkLoc(org.a);
  await db.insert(aiVisibilitySettings).values({ locationId: loc.row.id, orgId: org.orgId, enabled: true, category: "dentist", city: "Austin", engines });
  return { org, locationId: loc.row.id };
}

/** A transport that records its calls and reports a cost per call, like DataForSEO's `cost`. */
function recording(costUsd = 0.004) {
  const calls: { engine: string; prompt: string }[] = [];
  const fx = fixtureAiTransport();
  const transport: AiTransport = {
    async ask(engine, prompt, ctx) {
      calls.push({ engine, prompt });
      return { ...(await fx.ask(engine, prompt, ctx)), costUsd };
    },
  };
  return { calls, transport };
}
const resultsOf = (locationId: string) =>
  db.select({ r: aiVisibilityResults }).from(aiVisibilityResults).innerJoin(aiVisibilityRuns, eq(aiVisibilityRuns.id, aiVisibilityResults.runId)).where(eq(aiVisibilityRuns.locationId, locationId)).then((x) => x.map((y) => y.r));
const runsOf = (locationId: string) => db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.locationId, locationId));
const spendRows = () => db.select().from(platformDfsSpend).where(eq(platformDfsSpend.kind, "ai_visibility"));

describe("K5: weekly check (fixture)", () => {
  it("stores one result per engine and prompt, free and labelled fixture, and is not due again for a week", async () => {
    const { locationId } = await enabledLocation();
    const spendBefore = (await spendRows()).length;
    const out = await runAiVisibilityCheck(db, locationId, { source: "fixture" });
    const prompts = 3; // best dentist in Austin + two extra phrasings (no tracker keywords)
    expect(out).toMatchObject({ outcome: "stored", results: prompts * AI_ENGINES.length, chargedUsd: 0 });
    const rows = await resultsOf(locationId);
    expect(rows).toHaveLength(prompts * AI_ENGINES.length); // denominator: 3 prompts x 4 engines
    expect(new Set(rows.map((r) => r.engine))).toEqual(new Set(AI_ENGINES));
    expect(rows.some((r) => r.mentioned)).toBe(true);
    expect(rows.every((r) => r.competitors.includes("Sample Competitor One") && r.excerpt.length > 0)).toBe(true);
    expect((await runsOf(locationId))[0]).toMatchObject({ dataSource: "fixture", promptCount: prompts });
    expect((await spendRows()).length).toBe(spendBefore);
    expect(await runAiVisibilityCheck(db, locationId, { source: "fixture" })).toEqual({ outcome: "not_due" });
    expect(await runAiVisibilityCheck(db, locationId, { source: "fixture", now: new Date(Date.now() + 7 * 86_400_000) })).toMatchObject({ outcome: "stored" });
  });

  it("does nothing for a location that was never switched on or is switched off", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    expect(await runAiVisibilityCheck(db, loc.row.id, { source: "fixture" })).toEqual({ outcome: "not_enabled" });
    await db.insert(aiVisibilitySettings).values({ locationId: loc.row.id, orgId: org.orgId, enabled: false, category: "dentist", city: "Austin", engines: ["chatgpt"] });
    expect(await runAiVisibilityCheck(db, loc.row.id, { source: "fixture" })).toEqual({ outcome: "not_enabled" });
    expect(await runsOf(loc.row.id)).toHaveLength(0);
  });

  it("only the chosen engines are asked, and a manual check ignores the schedule", async () => {
    const { locationId } = await enabledLocation(["perplexity"]);
    const t = recording(0);
    await runAiVisibilityCheck(db, locationId, { source: "fixture", transport: t.transport });
    expect(new Set(t.calls.map((c) => c.engine))).toEqual(new Set(["perplexity"]));
    expect(await runAiVisibilityCheck(db, locationId, { source: "fixture", transport: t.transport })).toEqual({ outcome: "not_due" });
    expect(await runAiVisibilityCheck(db, locationId, { source: "fixture", transport: t.transport, force: true })).toMatchObject({ outcome: "stored" });
  });

  it("the daily job checks enabled locations that are due and leaves the rest", async () => {
    const a = await enabledLocation();
    const b = await enabledLocation();
    await db.update(aiVisibilitySettings).set({ lastCheckedAt: new Date() }).where(eq(aiVisibilitySettings.locationId, b.locationId));
    const out = await enqueueDueAiVisibilityChecks(db, { source: "fixture", orgIds: [a.org.orgId, b.org.orgId] });
    expect(out).toEqual({ checked: 2, stored: 1, skipped: 0 });
    expect(await runsOf(a.locationId)).toHaveLength(1);
    expect(await runsOf(b.locationId)).toHaveLength(0);
  });
});

describe("K5: charging (live, transport stubbed)", () => {
  it("charges the reported cost plus the org markup, counts it in the monthly spend and on the platform ledger", async () => {
    const { org, locationId } = await enabledLocation();
    const t = recording(0.004);
    const spendBefore = (await spendRows()).length;
    const out = await runAiVisibilityCheck(db, locationId, { source: "live", transport: t.transport });
    expect(out.outcome).toBe("stored");
    expect(t.calls).toHaveLength(12);
    const [run] = await runsOf(locationId);
    expect(Number(run!.providerCostUsd)).toBeCloseTo(12 * 0.004, 6);
    // Default markup 28%: 0.048 x 1.28 = 0.06144, rounded up to 4 decimals.
    expect(Number(run!.chargedUsd)).toBeCloseTo(0.0615, 6);
    expect(await monthToDateUsd(db, org.orgId, new Date())).toBeCloseTo(0.0615, 6);
    const spend = await spendRows();
    expect(spend.length).toBe(spendBefore + 1);
    expect(Number(spend.at(-1)!.costUsd)).toBeCloseTo(0.048, 4);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.action, "ai_visibility.check")));
    expect(audit).toHaveLength(1);
  });

  it("the estimate shown before enabling is the config unit prices x prompts, with the markup", async () => {
    const { org } = await enabledLocation();
    const e = await checkEstimate(db, org.orgId, AI_ENGINES);
    const unit = AI_ENGINES.reduce((s, x) => s + AI_VISIBILITY.engines[x].unitUsd, 0);
    expect(e.providerUsd).toBeCloseTo(3 * unit, 4);
    expect(e.chargedUsd).toBeCloseTo(3 * unit * 1.28, 3);
  });

  it("an org over its monthly budget makes no call, is audited, and retries next period", async () => {
    const { org, locationId } = await enabledLocation();
    await db.insert(orgGridSettings).values({ orgId: org.orgId, monthlyBudgetUsd: "0.00", markupPercent: "28" });
    const t = recording();
    const out = await runAiVisibilityCheck(db, locationId, { source: "live", transport: t.transport, alert: async () => {} });
    expect(out).toEqual({ outcome: "skipped_limit" });
    expect(t.calls).toHaveLength(0);
    expect(await runsOf(locationId)).toHaveLength(0);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.action, "ai_visibility.check_skipped")));
    expect(JSON.stringify(audit[0]!.after)).toContain("budget_exceeded");
    const [s] = await db.select().from(aiVisibilitySettings).where(eq(aiVisibilitySettings.locationId, locationId));
    expect(s!.lastCheckedAt).not.toBeNull();
  });

  it("the platform daily cap stops the check before any call", async () => {
    const { locationId } = await enabledLocation();
    await db.insert(platformDfsSpend).values({ kind: "test_fill_k5", costUsd: "5.0000" });
    try {
      const t = recording();
      const out = await runAiVisibilityCheck(db, locationId, { source: "live", transport: t.transport, alert: async () => {} });
      expect(out).toEqual({ outcome: "skipped_limit" });
      expect(t.calls).toHaveLength(0);
    } finally {
      await db.delete(platformDfsSpend).where(eq(platformDfsSpend.kind, "test_fill_k5"));
    }
  });

  it("a refused DataForSEO account stores nothing, charges nothing, alerts, and keeps the schedule due", async () => {
    const { org, locationId } = await enabledLocation();
    const alerts: string[] = [];
    const refuse: AiTransport = { ask: async () => { throw new DfsAccountError(40200, "Payment Required"); } };
    const out = await runAiVisibilityCheck(db, locationId, { source: "live", transport: refuse, alert: async (s) => void alerts.push(s) });
    expect(out).toEqual({ outcome: "failed" });
    expect(alerts).toHaveLength(1);
    expect(await runsOf(locationId)).toHaveLength(0);
    expect(await monthToDateUsd(db, org.orgId, new Date())).toBe(0);
    const [s] = await db.select().from(aiVisibilitySettings).where(eq(aiVisibilitySettings.locationId, locationId));
    expect(s!.lastCheckedAt).toBeNull();
    const reserved = (await spendRows()).filter((r) => Number(r.costUsd) === 0 && r.locationId === locationId);
    expect(reserved).toHaveLength(1);
  });

  it("one engine failing is stored as an error and not charged; the others are", async () => {
    const { locationId } = await enabledLocation(["chatgpt", "gemini"]);
    const fx = fixtureAiTransport();
    const flaky: AiTransport = { ask: async (e, p, c) => (e === "gemini" ? { result: null, costUsd: 0 } : { ...(await fx.ask(e, p, c)), costUsd: 0.004 }) };
    await runAiVisibilityCheck(db, locationId, { source: "live", transport: flaky });
    const rows = await resultsOf(locationId);
    expect(rows.filter((r) => r.engine === "gemini").every((r) => r.error === "no_answer" && !r.mentioned)).toBe(true);
    const [run] = await runsOf(locationId);
    expect(Number(run!.providerCostUsd)).toBeCloseTo(3 * 0.004, 6);
  });
});

describe("K5: trend", () => {
  it("shows the mention rate per engine per run, oldest first, and the latest competitors, scoped to the org", async () => {
    const { org, locationId } = await enabledLocation(["chatgpt"]);
    await runAiVisibilityCheck(db, locationId, { source: "fixture", now: new Date("2026-10-01T05:45:00Z") });
    await runAiVisibilityCheck(db, locationId, { source: "fixture", now: new Date("2026-10-08T05:45:00Z") });
    const o = await aiVisibilityOverview(db, org.orgId, locationId);
    expect(o.trend.map((p) => p.date)).toEqual(["2026-10-01", "2026-10-08"]);
    for (const p of o.trend) expect(p.engines.chatgpt).toMatchObject({ answered: 3, rate: p.engines.chatgpt!.mentioned / 3 });
    expect(o.latest!.competitors[0]).toEqual({ name: "Sample Competitor One", mentions: 3 });
    const other = await kit.makeOrg();
    expect(await aiVisibilityOverview(db, other.orgId, locationId)).toEqual({ trend: [], latest: null });
  });
});
