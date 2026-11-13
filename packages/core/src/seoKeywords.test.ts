import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createDb, seoKeywordResearchRuns } from "@opengmb/db";
import type { Actor } from "./actor";
import { executeToolCall } from "./executor";
import { MockGoogleClient } from "./google/mock-client";
import { researchEstimateUsd } from "./seo/keywords/estimate";
import { SEO_KEYWORDS_QUEUE, runKeywordResearch } from "./seo/keywords/run";
import { codeOf, makeKit } from "./testkit";

// SEO1: the four keyword research actions: price, paid search, reads, city search, and the MCP shape. No live calls.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
const boss = new PgBoss(url);
beforeAll(async () => {
  await boss.start();
  await boss.createQueue(SEO_KEYWORDS_QUEUE);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await boss.stop();
  await kit.deactivateAll();
  await sql.end();
});

const CITY = "Austin,Texas,United States";
type Est = { providerUsd: number; chargedUsd: number; cached: boolean; balanceUsd: number | null; remainingBudgetUsd: number; wouldExceed: boolean; priceSourceUrls: string[] };
type Started = { runId: string; status: string; cached: boolean; chargedUsd: number };
type Got = { run: { status: string; chargedUsd: number | null; rowCount: number; city: string | null } | null; rows: { keyword: string; localVolume?: number | null }[]; history: { seed: string; chargedUsd: number | null }[] };
const q = (ws: string, extra: object = {}) => ({ workspaceId: ws, seed: "plumber", countryIso: "US", city: CITY, ...extra });

describe("SEO1 keyword research actions", () => {
  it("1. estimate: provider price, price with markup, balance and budget; not for a client viewer", async () => {
    const org = await kit.makeOrg();
    const e = await kit.run<Est>(org.manager, "seo.keywords.estimate", q(org.a));
    expect(e.providerUsd).toBeCloseTo(researchEstimateUsd({ rows: 150, city: true }), 6);
    expect(e.chargedUsd).toBeGreaterThan(e.providerUsd);
    expect(e).toMatchObject({ cached: false, wouldExceed: false });
    expect(e.priceSourceUrls.length).toBe(2);
    expect(await codeOf(kit.run(org.viewerA, "seo.keywords.estimate", q(org.a)))).toBe("FORBIDDEN");
  });

  it("2. research: queues, the worker finishes it, a repeat is free and returns the same run; maxChargeUsd is enforced", async () => {
    const org = await kit.makeOrg();
    const e = await kit.run<Est>(org.manager, "seo.keywords.estimate", q(org.a));
    const first = await kit.run<Started>(org.manager, "seo.keywords.research", q(org.a, { maxChargeUsd: e.chargedUsd }));
    expect(first).toMatchObject({ status: "queued", cached: false });
    const jobs = await boss.fetch<{ runId: string }>(SEO_KEYWORDS_QUEUE, { batchSize: 100 });
    expect(jobs.map((j) => j.data.runId)).toContain(first.runId);
    const [queued] = await db.select().from(seoKeywordResearchRuns).where(eq(seoKeywordResearchRuns.id, first.runId));
    expect(Number(queued!.estimateChargeUsd)).toBeCloseTo(e.chargedUsd, 4); // the price shown is the price reserved
    expect(await runKeywordResearch(db, first.runId)).toEqual({ outcome: "done" });
    const again = await kit.run<Started>(org.manager, "seo.keywords.research", q(org.a, { maxChargeUsd: 0 }));
    expect(again).toMatchObject({ runId: first.runId, cached: true, chargedUsd: 0 });
    expect(await db.select().from(seoKeywordResearchRuns).where(eq(seoKeywordResearchRuns.workspaceId, org.a))).toHaveLength(1);
    const est2 = await kit.run<Est>(org.manager, "seo.keywords.estimate", q(org.a));
    expect(est2).toMatchObject({ cached: true, chargedUsd: 0, providerUsd: 0 });
    // too low a ceiling on a new query is refused before anything is created
    const msg = await kit.run(org.manager, "seo.keywords.research", q(org.a, { seed: "electrician", maxChargeUsd: 0.0001 })).catch((x: Error) => x.message);
    expect(msg).toMatch(/The price is now \$\d/);
    expect(await db.select().from(seoKeywordResearchRuns).where(eq(seoKeywordResearchRuns.workspaceId, org.a))).toHaveLength(1);
  });

  it("4. inputs: unknown city, country FR, a long seed, another workspace's location", async () => {
    const org = await kit.makeOrg();
    const other = await kit.makeOrg();
    const otherLoc = await other.mkLoc(other.a);
    const base = { maxChargeUsd: 5 };
    expect(await codeOf(kit.run(org.manager, "seo.keywords.research", q(org.a, { ...base, city: "Nowhere,Texas,United States" })))).toBe("INVALID_INPUT");
    expect(await codeOf(kit.run(org.manager, "seo.keywords.research", q(org.a, { ...base, countryIso: "FR" })))).toBe("INVALID_INPUT");
    expect(await codeOf(kit.run(org.manager, "seo.keywords.research", q(org.a, { ...base, seed: "x".repeat(81) })))).toBe("INVALID_INPUT");
    expect(await codeOf(kit.run(org.manager, "seo.keywords.research", q(org.a, { ...base, locationId: otherLoc.row.id })))).toBe("NOT_FOUND");
    expect(await codeOf(kit.run(org.approverB, "seo.keywords.research", q(org.a, base)))).toBe("FORBIDDEN");
  });

  it("5. get: one run with rows, the history without; viewers read but see no money; another org gets NOT_FOUND", async () => {
    const org = await kit.makeOrg();
    const other = await kit.makeOrg();
    const s = await kit.run<Started>(org.manager, "seo.keywords.research", q(org.a, { maxChargeUsd: 5 }));
    await runKeywordResearch(db, s.runId);
    const one = await kit.run<Got>(org.manager, "seo.keywords.get", { runId: s.runId });
    expect(one.run).toMatchObject({ status: "done", city: CITY });
    expect(one.rows.length).toBeGreaterThan(5);
    expect(one.rows[0]!.localVolume).not.toBeUndefined();
    expect(one.run!.chargedUsd).not.toBeNull();
    const hist = await kit.run<Got>(org.manager, "seo.keywords.get", { workspaceId: org.a });
    expect(hist.history.map((h) => h.seed)).toEqual(["plumber"]);
    expect(hist.rows).toEqual([]);
    const viewer = await kit.run<Got>(org.viewerA, "seo.keywords.get", { runId: s.runId });
    expect(viewer.run!.chargedUsd).toBeNull();
    expect(viewer.rows.length).toBe(one.rows.length);
    expect(await codeOf(kit.run(other.manager, "seo.keywords.get", { runId: s.runId }))).toBe("NOT_FOUND");
    expect(await codeOf(kit.run(org.manager, "seo.keywords.get", {}))).toBe("INVALID_INPUT");
    expect(await codeOf(kit.run(org.viewerA, "seo.keywords.get", { workspaceId: org.b }))).toBe("FORBIDDEN");
  });

  it("6. cities.search returns Austin for 'aust'", async () => {
    const org = await kit.makeOrg();
    const r = await kit.run<{ cities: { locationName: string }[] }>(org.viewerA, "seo.cities.search", { countryIso: "US", query: "aust" });
    expect(r.cities.map((c) => c.locationName)).toContain(CITY);
    expect((await kit.run<{ cities: unknown[] }>(org.viewerA, "seo.cities.search", { countryIso: "US", query: "a" })).cities).toEqual([]);
  });

  it("7. over MCP the write is a proposal whose preview names the price", async () => {
    const org = await kit.makeOrg();
    const made = (await kit.run<{ apiToken: { id: string } }>(org.owner, "apiTokens.create", { name: "seo" })).apiToken;
    const agent: Actor = { ...org.owner, surface: "mcp", actorType: "api_token", apiTokenId: made.id, scopes: ["read", "write"] };
    const out = (await executeToolCall(db, agent, "seo.keywords.research", q(org.a, { maxChargeUsd: 5 }))) as { preview?: { summary: string } };
    expect(out.preview?.summary).toMatch(/Keyword research for "plumber" in Austin/);
    expect(out.preview?.summary).toMatch(/\$\d+\.\d\d/);
    expect(await db.select().from(seoKeywordResearchRuns).where(eq(seoKeywordResearchRuns.workspaceId, org.a))).toHaveLength(0);
  });

  it("8. the price is whole cents and one number: shown, reserved, and accepted as the ceiling", async () => {
    const org = await kit.makeOrg();
    const e = await kit.run<Est>(org.manager, "seo.keywords.estimate", q(org.a, { seed: "roofer" }));
    expect(Math.abs(e.chargedUsd * 100 - Math.round(e.chargedUsd * 100))).toBeLessThan(1e-9);
    const agent = await mcpAgent(org);
    const out = (await executeToolCall(db, agent, "seo.keywords.research", q(org.a, { seed: "roofer", maxChargeUsd: e.chargedUsd }))) as { proposalId?: string; preview?: { summary: string } };
    expect(out.preview?.summary).toBeTruthy();
    const started = await kit.run<Started>(org.manager, "seo.keywords.research", q(org.a, { seed: "roofer", maxChargeUsd: e.chargedUsd }));
    const [row] = await db.select().from(seoKeywordResearchRuns).where(eq(seoKeywordResearchRuns.id, started.runId));
    expect(Number(row!.estimateChargeUsd)).toBe(e.chargedUsd);
  });

  it("9. only a done run with rows and no city-volume note is a free repeat; a run in flight is reused, even under a race", async () => {
    const org = await kit.makeOrg();
    const key = (seed: string) => `${org.a}|${seed}|US|${CITY}|150`;
    const base = (seed: string) => ({ orgId: org.orgId, workspaceId: org.a, seed, countryIso: "US", languageCode: "en", cityLocationName: CITY, rowLimit: 150, cacheKey: key(seed), dataSource: "fixture" as const, estimateChargeUsd: "0.2000" });
    const good = [{ keyword: "x", searchVolume: 1, trend: [], cpc: 1, competition: 0.1, keywordDifficulty: 1, intent: "unknown", localVolume: 1 }];
    await db.insert(seoKeywordResearchRuns).values([
      { ...base("empty"), status: "done", rows: [] },
      { ...base("noted"), status: "done", rows: good, localVolumeNote: "local_volume_failed" },
      { ...base("failed"), status: "failed", rows: [] },
    ]);
    for (const seed of ["empty", "noted", "failed"]) {
      const r = await kit.run<Started>(org.manager, "seo.keywords.research", q(org.a, { seed, maxChargeUsd: 5 }));
      expect(r.cached, seed).toBe(false);
    }
    // two identical requests at once buy one search
    const both = await Promise.all([1, 2].map(() => kit.run<Started>(org.manager, "seo.keywords.research", q(org.a, { seed: "gutter", maxChargeUsd: 5 }))));
    expect(both[0]!.runId).toBe(both[1]!.runId);
    expect(both.filter((b) => !b.cached)).toHaveLength(1);
    expect(await db.select().from(seoKeywordResearchRuns).where(and(eq(seoKeywordResearchRuns.workspaceId, org.a), eq(seoKeywordResearchRuns.seed, "gutter")))).toHaveLength(1);
    // the estimate also says it is free while that run is in flight
    expect(await kit.run<Est>(org.manager, "seo.keywords.estimate", q(org.a, { seed: "gutter" }))).toMatchObject({ cached: true, chargedUsd: 0, inFlight: true });
  });

  it("10. the MCP preview of a stored live result says free now and names the most it could cost; no credit wording without billing", async () => {
    vi.stubEnv("DATAFORSEO_LOGIN", "login");
    vi.stubEnv("DATAFORSEO_PASSWORD", "password");
    try {
      const org = await kit.makeOrg();
      const rows = [{ keyword: "x", searchVolume: 1, trend: [], cpc: 1, competition: 0.1, keywordDifficulty: 1, intent: "unknown", localVolume: 1 }];
      await db.insert(seoKeywordResearchRuns).values({ orgId: org.orgId, workspaceId: org.a, seed: "plumber", countryIso: "US", languageCode: "en", cityLocationName: CITY, rowLimit: 150, cacheKey: `${org.a}|plumber|US|${CITY}|150`, dataSource: "live", status: "done", estimateChargeUsd: "0.2000", rows });
      const agent = await mcpAgent(org);
      const cached = (await executeToolCall(db, agent, "seo.keywords.research", q(org.a, { maxChargeUsd: 7.5 }))) as { preview: { summary: string } };
      expect(cached.preview.summary).toMatch(/free now \(stored result from \d{4}-\d\d-\d\d\); at most \$7\.50 if the stored result has expired when this is applied/);
      const fresh = (await executeToolCall(db, agent, "seo.keywords.research", q(org.a, { seed: "electrician", maxChargeUsd: 7.5 }))) as { preview: { summary: string } };
      expect(fresh.preview.summary).toMatch(/\$\d+\.\d\d$/);
      expect(fresh.preview.summary + cached.preview.summary).not.toMatch(/from your credit/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

async function mcpAgent(org: Awaited<ReturnType<typeof kit.makeOrg>>): Promise<Actor> {
  const made = (await kit.run<{ apiToken: { id: string } }>(org.owner, "apiTokens.create", { name: "seo" })).apiToken;
  return { ...org.owner, surface: "mcp", actorType: "api_token", apiTokenId: made.id, scopes: ["read", "write"] };
}
