import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { aiUsage, auditLog, createDb } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit, type Org } from "./testkit";
import { setAiTestOverrides, type AiModel } from "./ai/model";
import { costMicroUsd, platformCapMicroUsd, utcMonthStart } from "./ai/money";
import { buildStartupReport } from "./config/startup";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: pg } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
const { run } = kit;

let org: Org;
let other: Org;
beforeAll(async () => {
  org = await kit.makeOrg();
  other = await kit.makeOrg();
});
afterAll(async () => {
  setAiTestOverrides({});
  vi.unstubAllGlobals();
  await kit.deactivateAll();
  await pg.end();
});

const CANARY_IN = "ZQXCANARYSOURCE";
const CANARY_OUT = "ZQXCANARYOUTPUT";
const calls: { system: string; user: string }[] = [];
const fake =
  (text: string, inputTokens = 100, outputTokens = 50): AiModel =>
  async (req) => {
    calls.push({ system: req.system, user: req.user });
    return { text, inputTokens, outputTokens };
  };
const useModel = (m: AiModel, cap = "1000") =>
  setAiTestOverrides({ model: m, env: { AI_MONTHLY_BUDGET_USD: cap } });

const spentRows = (workspaceId: string) =>
  db.select().from(aiUsage).where(eq(aiUsage.workspaceId, workspaceId));
const platformSpent = async () => {
  const [r] = await db
    .select({ s: sql<string>`coalesce(sum(${aiUsage.costMicroUsd}) filter (where ${aiUsage.createdAt} >= ${utcMonthStart(new Date()).toISOString()}::timestamptz), 0)` })
    .from(aiUsage);
  return Number(r!.s);
};
const draft = (workspaceId = org.a, extra: Record<string, unknown> = {}, actor = org.manager) =>
  run<{ status: string; draft: string | null; blockedRuleIds: string[]; costMicroUsd: number }>(
    actor,
    "ai.draftText",
    { workspaceId, purpose: "reply", sourceText: `Great visit ${CANARY_IN}`, rating: 5, ...extra },
  );

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", () => {
    throw new Error("the real network must never be reached in tests");
  });
});

describe("ai.draftText", () => {
  it("returns a draft, meters it, and audits ids and lengths but never text", async () => {
    useModel(fake(`Thank you for the kind words. ${CANARY_OUT}`));
    const before = (await spentRows(org.a)).length;
    const r = await draft();
    expect(r.status).toBe("ok");
    expect(r.draft).toContain(CANARY_OUT);
    expect(r.costMicroUsd).toBe(costMicroUsd("claude-haiku-5-5", 100, 50));
    const rows = await spentRows(org.a);
    expect(rows).toHaveLength(before + 1);
    const row = rows.at(-1)!;
    expect(row).toMatchObject({ workspaceId: org.a, model: "claude-haiku-5-5", inputTokens: 100, outputTokens: 50, action: "ai.draftText", purpose: "reply" });
    const audit = await kit.auditRows(org.orgId, "ai.draft");
    expect(audit.length).toBeGreaterThan(0);
    const all = JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.orgId, org.orgId)));
    expect(all).not.toContain(CANARY_IN);
    expect(all).not.toContain(CANARY_OUT);
    expect(JSON.stringify(audit.at(-1)!.after)).toContain('"model":"claude-haiku-5-5"');
    // the usage row has no text columns at all
    expect(JSON.stringify(row)).not.toContain(CANARY_OUT);
  });

  it("a guardrail block is returned as blocked with rule ids, no text, and is still metered", async () => {
    useModel(fake(`Visit https://spam.example.test ${CANARY_OUT}`));
    const before = (await spentRows(org.a)).length;
    const r = await draft();
    expect(r.status).toBe("blocked");
    expect(r.draft).toBeNull();
    expect(r.blockedRuleIds).toContain("U7.url");
    expect(JSON.stringify(r)).not.toContain(CANARY_OUT);
    expect((await spentRows(org.a)).length).toBe(before + 1);
    const all = JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.orgId, org.orgId)));
    expect(all).not.toContain(CANARY_OUT);
    expect(all).toContain("U7.url");
  });

  it("a post purpose runs the post guardrails", async () => {
    useModel(fake("Join us at https://x.example.test"));
    const r = await draft(org.a, { purpose: "post", rating: undefined });
    expect(r.status).toBe("blocked");
    expect(r.blockedRuleIds).toContain("U7.url");
  });

  it("is refused when the platform cap would be exceeded, counting another organization's spend", async () => {
    const m = vi.fn(fake("Thanks!"));
    // spend made by ANOTHER organization is what fills the platform cap
    await db.insert(aiUsage).values({
      orgId: other.orgId, workspaceId: other.a, action: "ai.draftText", purpose: "reply",
      model: "claude-haiku-5-5", inputTokens: 1, outputTokens: 1, costMicroUsd: 5_000_000,
    });
    const spent = await platformSpent();
    useModel(m, ((spent + 200) / 1e6).toFixed(6));
    const rowsBefore = (await spentRows(org.a)).length;
    expect(await codeOf(draft())).toBe("FORBIDDEN");
    await expect(draft()).rejects.toThrow(/platform's monthly AI limit/);
    expect(m).not.toHaveBeenCalled();
    expect((await spentRows(org.a)).length).toBe(rowsBefore);
    // with room, it works again
    useModel(m, ((spent + 100_000) / 1e6).toFixed(6));
    expect((await draft()).status).toBe("ok");
    expect(m).toHaveBeenCalledTimes(1);
  });

  it("last month's spend does not count toward this month", async () => {
    const start = utcMonthStart(new Date());
    const lastMonth = new Date(start.getTime() - 24 * 3600 * 1000);
    await db.insert(aiUsage).values({
      orgId: org.orgId, workspaceId: org.b, action: "ai.draftText", purpose: "reply",
      model: "claude-haiku-5-5", inputTokens: 1, outputTokens: 1, costMicroUsd: 900_000_000, createdAt: lastMonth,
    });
    const thisMonth = await platformSpent();
    useModel(fake("Thanks!"), ((thisMonth + 100_000) / 1e6).toFixed(6));
    expect((await draft(org.b)).status).toBe("ok");
  });

  it("a per-client cap refuses that client only", async () => {
    const m = vi.fn(fake("Thanks!"));
    useModel(m);
    expect(await run(org.owner, "aiUsage.setClientCap", { workspaceId: org.a, monthlyCapUsd: 0 })).toMatchObject({ monthlyCapUsd: 0 });
    expect(await codeOf(draft(org.a))).toBe("FORBIDDEN");
    await expect(draft(org.a)).rejects.toThrow(/this client's monthly AI limit/);
    expect(m).not.toHaveBeenCalled();
    expect((await draft(org.b)).status).toBe("ok"); // another client of the same org
    expect(m).toHaveBeenCalledTimes(1);
    await run(org.owner, "aiUsage.setClientCap", { workspaceId: org.a, monthlyCapUsd: null });
    expect((await draft(org.a)).status).toBe("ok");
  });

  it("fails clearly when this server has no key, without touching the network", async () => {
    setAiTestOverrides({ env: {} });
    expect(await codeOf(draft())).toBe("NOT_CONFIGURED");
    await expect(draft()).rejects.toThrow("AI is not set up on this server");
  });

  it("feeds the client's brand voice into the system prompt", async () => {
    useModel(fake("Thanks!"));
    await run(org.manager, "aiVoice.update", {
      workspaceId: org.a, tone: "calm and kind", bannedWords: ["amazing", "best"], signOff: "The Team", language: "Spanish",
    });
    await draft(org.a);
    const sys = calls.at(-1)!.system;
    expect(sys).toContain("calm and kind");
    expect(sys).toContain("amazing, best");
    expect(sys).toContain("The Team");
    expect(sys).toContain("Spanish");
    expect(calls.at(-1)!.user).toContain(CANARY_IN);
    const voiceAudit = JSON.stringify(await kit.auditRows(org.orgId, "ai_voice.update"));
    expect(voiceAudit).not.toContain("calm and kind");
  });

  it("permissions: viewers cannot draft, managers cannot set a cap, owners can", async () => {
    useModel(fake("Thanks!"));
    expect(await codeOf(draft(org.a, {}, org.viewerA))).toBe("FORBIDDEN");
    expect(await codeOf(run(org.manager, "aiUsage.setClientCap", { workspaceId: org.a, monthlyCapUsd: 5 }))).toBe("FORBIDDEN");
    expect(await codeOf(run(org.manager, "aiUsage.get"))).toBe("FORBIDDEN");
    expect(await codeOf(draft(other.a))).toBe("NOT_FOUND"); // another organization's client
    const u = await run<{ clients: { workspaceId: string; spentUsd: number }[]; platform: unknown }>(org.owner, "aiUsage.get");
    expect(u.clients.map((c) => c.workspaceId)).toContain(org.a);
    expect(u.platform).toBeNull(); // not a platform admin
  });
});

describe("money and startup", () => {
  it("prices a long prompt at the higher tier and rounds up", () => {
    expect(costMicroUsd("claude-haiku-5-5", 1_000_000, 0)).toBe(500_000);
    expect(costMicroUsd("claude-haiku-5-5", 100_000, 0)).toBe(10_000);
    expect(costMicroUsd("claude-haiku-5-5", 100_001, 0)).toBe(50_001); // 100_001 * 0.5, tier applies to the whole call
    expect(costMicroUsd("claude-haiku-5-5", 1, 1)).toBe(1);
    expect(costMicroUsd("claude-sonnet-5-5", 1000, 1000)).toBe(12_000);
  });
  it("reads the platform cap from the env, default 10 USD", () => {
    expect(platformCapMicroUsd({})).toBe(10_000_000);
    expect(platformCapMicroUsd({ AI_MONTHLY_BUDGET_USD: "2.5" })).toBe(2_500_000);
    expect(platformCapMicroUsd({ AI_MONTHLY_BUDGET_USD: "abc" })).toBe(10_000_000);
  });
  it("startup prints ai=on/off and never the key", () => {
    const base = { NODE_ENV: "test" };
    const off = buildStartupReport("web", base).lines.join("\n");
    expect(off).toContain("ai=off");
    const on = buildStartupReport("worker", { ...base, ANTHROPIC_API_KEY: "sk-ant-secretvalue" }).lines.join("\n");
    expect(on).toContain("ai=on");
    expect(on).toContain("ANTHROPIC_API_KEY=present");
    expect(on).not.toContain("secretvalue");
  });
});
