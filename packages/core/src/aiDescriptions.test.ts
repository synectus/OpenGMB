import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiUsage, auditLog, createDb, searchKeywordsMonthly } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit, type Org } from "./testkit";
import { setAiTestOverrides, type AiModel } from "./ai/model";
import { PROFILE_LIMITS } from "./config/profile-limits";
import { lastCompleteMonth } from "./performance/dates";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: pg } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
const { run } = kit;

const BUSINESS_MAX = PROFILE_LIMITS.descriptionMaxChars.limit;
const SERVICE_MAX = PROFILE_LIMITS.serviceDescriptionMaxChars.limit;
const CANARY_IN = "ZQXCANARYSOURCE";
const CANARY_OUT = "ZQXCANARYOUTPUT";

let org: Org;
let other: Org;
let loc: Awaited<ReturnType<Org["mkLoc"]>>;
let bare: Awaited<ReturnType<Org["mkLoc"]>>;
beforeAll(async () => {
  org = await kit.makeOrg();
  other = await kit.makeOrg();
  loc = await org.mkLoc(org.a);
  bare = await org.mkLoc(org.a);
  const month = `${lastCompleteMonth(new Date())}-01`;
  const row = (keyword: string, value: number | null, threshold: number | null) => ({
    orgId: org.orgId, locationId: loc.row.id, month, keyword, value, threshold,
  });
  await db.insert(searchKeywordsMonthly).values([
    row("emergency dentist", 90, null),
    row("teeth whitening", 60, null),
    row("invisalign", 40, null),
    row("dental implants", 30, null),
    row("root canal", 20, null),
    row("cheap braces", 10, null),
    row("hidden term", null, 15), // Google hid the count: never offered
  ]);
});
afterAll(async () => {
  setAiTestOverrides({});
  vi.unstubAllGlobals();
  await kit.deactivateAll();
  await pg.end();
});

const calls: { system: string; user: string }[] = [];
/** Answers by call index (the last one repeats) and records what it was sent. */
const fake =
  (answers: string[]): AiModel =>
  async (req) => {
    calls.push({ system: req.system, user: req.user });
    return { text: answers[Math.min(calls.length - 1, answers.length - 1)]!, inputTokens: 100, outputTokens: 50 };
  };
const useModel = (m: AiModel) => setAiTestOverrides({ model: m, env: { AI_MONTHLY_BUDGET_USD: "1000" } });
const usage = (workspaceId: string) => db.select().from(aiUsage).where(eq(aiUsage.workspaceId, workspaceId));
const chars = (s: string | null) => Array.from(s ?? "").length;

type Out = {
  status: string; draft: string | null; blockedRuleIds: string[]; warningRuleIds: string[];
  retried: boolean; truncated: boolean; maxChars: number; costMicroUsd: number;
  keywordsConsidered: string[]; keywordsIncluded: string[];
};
const business = (extra: Record<string, unknown> = {}, actor = org.manager, locationId = loc.row.id) =>
  run<Out>(actor, "ai.draftBusinessDescription", { locationId, ...extra });
const service = (extra: Record<string, unknown> = {}, actor = org.manager) =>
  run<Out>(actor, "ai.draftServiceDescription", { locationId: loc.row.id, serviceName: "Teeth cleaning", ...extra }, );

/** n characters of plain sentences, each ending with a full stop. */
const sentences = (n: number) => {
  let s = "";
  while (s.length < n) s += "We care for families in town. ";
  return s.trim();
};

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", () => {
    throw new Error("the real network must never be reached in tests");
  });
});

describe("ai.draftBusinessDescription", () => {
  it("a draft within the limit takes one call, is metered and audited without any text", async () => {
    useModel(fake([`We are a friendly dental clinic. ${CANARY_OUT}`]));
    const before = (await usage(org.a)).length;
    const r = await business({ currentDescription: `Old text ${CANARY_IN}` });
    expect(r.status).toBe("ok");
    expect(r.draft).toContain(CANARY_OUT);
    expect(r.maxChars).toBe(BUSINESS_MAX);
    expect(r.retried).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain(`at most ${BUSINESS_MAX} characters`);
    const rows = await usage(org.a);
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({ action: "ai.draftText", purpose: "description" });
    const audit = await kit.auditRows(org.orgId, "ai.draft");
    expect(audit.at(-1)!.after).toMatchObject({ purpose: "description", attempts: 1, truncated: false, status: "ok" });
    const all = JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.orgId, org.orgId)));
    expect(all).not.toContain(CANARY_IN);
    expect(all).not.toContain(CANARY_OUT);
  });

  it("over-limit text is retried once with a stricter instruction and the shorter answer is used", async () => {
    useModel(fake([sentences(BUSINESS_MAX + 200), sentences(500)]));
    const before = (await usage(org.a)).length;
    const r = await business();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.system).toContain("hard limit is 750");
    expect(calls[0]!.system).not.toContain("hard limit");
    expect(r.retried).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.status).toBe("ok");
    expect(chars(r.draft)).toBeLessThanOrEqual(BUSINESS_MAX);
    expect(chars(r.draft)).toBeGreaterThan(400);
    // both calls are metered
    expect((await usage(org.a)).length).toBe(before + 2);
    expect(r.costMicroUsd).toBeGreaterThan(0);
  });

  it("still over after the retry: cut at a sentence boundary under the limit, never returned over", async () => {
    useModel(fake([sentences(BUSINESS_MAX + 300), sentences(BUSINESS_MAX + 300)]));
    const r = await business();
    expect(calls).toHaveLength(2);
    expect(r.retried).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.status).toBe("ok");
    expect(chars(r.draft)).toBeLessThanOrEqual(BUSINESS_MAX);
    expect(r.draft!.endsWith("town.")).toBe(true);
  });

  it("a link in the model output is blocked and no text comes back", async () => {
    useModel(fake([`Visit https://clinic.example.test for more. ${CANARY_OUT}`]));
    const r = await business();
    expect(r.status).toBe("blocked");
    expect(r.draft).toBeNull();
    expect(r.blockedRuleIds).toContain("U7.url");
    expect(JSON.stringify(r)).not.toContain(CANARY_OUT);
  });

  it("an em dash is removed; a banned style word is a U8.style warning, not a block", async () => {
    useModel(fake(["We are a clinic — a comprehensive dental practice."]));
    const r = await business();
    expect(r.status).toBe("ok");
    expect(r.draft).not.toContain("—");
    expect(r.draft).toContain("clinic, a");
    expect(r.warningRuleIds).toContain("U8.style");
  });

  it("offers the top stored keywords (hidden ones never) and reports which the draft includes", async () => {
    useModel(fake(["Our emergency dentist team also does invisalign and teeth whitening."]));
    const r = await business();
    expect(r.keywordsConsidered).toEqual([
      "emergency dentist", "teeth whitening", "invisalign", "dental implants", "root canal",
    ]);
    expect(r.keywordsIncluded).toEqual(["emergency dentist", "teeth whitening", "invisalign"]);
    expect(calls[0]!.user).toContain("emergency dentist; teeth whitening");
    expect(calls[0]!.user).not.toContain("hidden term");
    expect(calls[0]!.user).not.toContain("cheap braces"); // sixth place
    expect(calls[0]!.user).toContain("Use each at most once");
  });

  it("a location with no stored keywords still drafts, with an empty report", async () => {
    useModel(fake(["We are a friendly clinic."]));
    const r = await business({}, org.manager, bare.row.id);
    expect(r.status).toBe("ok");
    expect(r.keywordsConsidered).toEqual([]);
    expect(r.keywordsIncluded).toEqual([]);
    expect(calls[0]!.user).not.toContain("Search terms");
  });

  it("uses the brand voice tone and banned words but not the reply sign-off", async () => {
    useModel(fake(["We are a clinic."]));
    await run(org.manager, "aiVoice.update", {
      workspaceId: org.a, tone: "calm and kind", bannedWords: ["gentle"], signOff: "The Team",
    });
    await business();
    const sys = calls[0]!.system;
    expect(sys).toContain("calm and kind");
    expect(sys).toContain("gentle");
    expect(sys).not.toContain("The Team");
  });

  it("needs profile:edit and review:draft, and stays inside the organization", async () => {
    useModel(fake(["We are a clinic."]));
    expect(await codeOf(business({}, org.viewerA))).toBe("FORBIDDEN");
    expect(await codeOf(business({}, other.manager))).toBe("NOT_FOUND");
    expect((await business({}, org.owner)).status).toBe("ok");
  });

  it("is refused before the model is called when the client's AI limit is reached", async () => {
    const m = vi.fn(fake(["We are a clinic."]));
    useModel(m);
    await run(org.owner, "aiUsage.setClientCap", { workspaceId: org.a, monthlyCapUsd: 0 });
    await expect(business()).rejects.toThrow(/this client's monthly AI limit/);
    expect(m).not.toHaveBeenCalled();
    await run(org.owner, "aiUsage.setClientCap", { workspaceId: org.a, monthlyCapUsd: null });
  });
});

describe("ai.draftServiceDescription", () => {
  it("drafts within the service limit, metered and audited without text", async () => {
    useModel(fake([`A thorough clean that keeps teeth healthy. ${CANARY_OUT}`]));
    const before = (await usage(org.a)).length;
    const r = await service({ categoryName: "Dentist", currentDescription: CANARY_IN });
    expect(r.status).toBe("ok");
    expect(r.maxChars).toBe(SERVICE_MAX);
    expect(calls[0]!.user).toContain("Service: Teeth cleaning");
    expect(calls[0]!.system).toContain(`at most ${SERVICE_MAX} characters`);
    expect((await usage(org.a)).length).toBe(before + 1);
    expect((await usage(org.a)).at(-1)).toMatchObject({ purpose: "service_description" });
    const all = JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.orgId, org.orgId)));
    expect(all).not.toContain(CANARY_IN);
    expect(all).not.toContain(CANARY_OUT);
    expect(JSON.stringify(r)).not.toContain("keywords");
  });

  it("over-limit text is retried once, then cut at a sentence end under the limit", async () => {
    useModel(fake([sentences(SERVICE_MAX + 400), sentences(SERVICE_MAX + 400)]));
    const r = await service();
    expect(calls).toHaveLength(2);
    expect(r.retried).toBe(true);
    expect(r.truncated).toBe(true);
    expect(chars(r.draft)).toBeLessThanOrEqual(SERVICE_MAX);
    expect(r.draft!.endsWith("town.")).toBe(true);
  });

  it("blocks a link, removes an em dash, and warns on a banned word", async () => {
    useModel(fake(["Book at https://clinic.example.test now."]));
    const blocked = await service();
    expect(blocked.status).toBe("blocked");
    expect(blocked.draft).toBeNull();
    expect(blocked.blockedRuleIds).toContain("U7.url");
    useModel(fake(["A robust clean — done by our team."]));
    const ok = await service();
    expect(ok.draft).not.toContain("—");
    expect(ok.warningRuleIds).toContain("U8.style");
  });

  it("needs profile:edit and review:draft", async () => {
    useModel(fake(["A clean."]));
    expect(await codeOf(service({}, org.viewerA))).toBe("FORBIDDEN");
    expect(await codeOf(service({}, other.manager))).toBe("NOT_FOUND");
  });
});
