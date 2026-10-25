import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  aiUsage,
  auditLog,
  createDb,
  postTargets,
  posts,
  profileSnapshots,
  reviews,
  workspaceReplySettings,
  workspaces,
} from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit, uniq, type Org } from "./testkit";
import { setAiTestOverrides, type AiModel } from "./ai/model";
import { ensureQueues } from "./jobs";
import { parseIdeas } from "./actions/aiPosts";
import { upcomingHolidays } from "./config/holidays";
import { todayIn } from "./ai/postSource";

/** The occasions line a market should get today (the filtering itself is tested in config/holidays.test.ts). */
const occasionsLine = (m: "us" | "au" | "in", tz: string) =>
  upcomingHolidays(m, todayIn(tz, new Date())).map((o) => `${o.name} (${o.date})`).join("; ");

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: pg } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
const { run } = kit;

let org: Org;
beforeAll(async () => {
  await ensureQueues(url, []);
  org = await kit.makeOrg();
});
afterAll(async () => {
  setAiTestOverrides({});
  vi.unstubAllGlobals();
  await kit.deactivateAll();
  await pg.end();
});

const CANARY = "ZQXPOSTCANARY";
const calls: { system: string; user: string }[] = [];
const businessOf = (user: string) => /Business: (.*)/.exec(user)![1]!;
/** Echoes the location name from the prompt, so each location's text is its own. */
const echo =
  (tweak: (text: string, n: number) => string = (t) => t, tokens = { i: 100, o: 50 }): AiModel =>
  async (req) => {
    calls.push({ system: req.system, user: req.user });
    const n = calls.length;
    return { text: tweak(`Visit ${businessOf(req.user)} this week, number ${n}. ${CANARY}`, n), inputTokens: tokens.i, outputTokens: tokens.o };
  };
const useModel = (m: AiModel) => setAiTestOverrides({ model: m, env: { AI_MONTHLY_BUDGET_USD: "1000" } });

let seq = 0;
async function mkLocs(n: number, city = "Austin") {
  const out = [];
  for (let i = 0; i < n; i++) {
    const tag = `${uniq().replace(/\D/g, "").slice(-5)}${seq++}`;
    out.push(
      await org.mkLoc(org.a, {
        title: `Riverside Dental ${tag}`,
        addressSummary: `${i + 1} Main St, ${city}${i}, TX 78701, US`,
      }),
    );
  }
  return out;
}
type Variants = {
  results: { locationId: string; outcome: string; postId: string | null; postStatus: string | null; reason: string | null; warningRuleIds: string[] }[];
  counts: Record<string, number>;
  stoppedOverCap: boolean;
};
const variants = (locationIds: string[], extra: Record<string, unknown> = {}, actor = org.manager) =>
  run<Variants>(actor, "ai.draftPostVariants", { workspaceId: org.a, locationIds, ...extra });
const usageCount = async () => (await db.select().from(aiUsage).where(eq(aiUsage.workspaceId, org.a))).length;

beforeEach(async () => {
  await run(org.owner, "aiUsage.setClientCap", { workspaceId: org.a, monthlyCapUsd: null });
  calls.length = 0;
  vi.stubGlobal("fetch", () => {
    throw new Error("the real network must never be reached in tests");
  });
});

describe("parseIdeas", () => {
  it("strips numbering and bullets and keeps five", () => {
    expect(parseIdeas("1. One\n2) Two\n- Three\n\n* Four\n5. Five\n6. Six")).toEqual(["One", "Two", "Three", "Four", "Five"]);
  });
});

describe("ai.postIdeas and ai.draftPost", () => {
  it("ideas: 5 lines from one metered call that carries services, praise themes and occasions, never a reviewer name", async () => {
    const [l] = await mkLocs(1);
    await db.insert(profileSnapshots).values({
      orgId: org.orgId,
      locationId: l!.row.id,
      source: "manual",
      hash: uniq(),
      data: { fields: { serviceItems: [{ freeFormServiceItem: { category: "c", label: { displayName: "Teeth whitening" } } }] } },
    });
    const now = new Date();
    await db.insert(reviews).values([
      { orgId: org.orgId, workspaceId: org.a, locationId: l!.row.id, googleReviewName: `${l!.parent}/reviews/${uniq()}a`, reviewerDisplayName: "Zed Surname", starRating: 5, comment: "Friendly staff, short wait.", createTime: now, updateTime: now },
      { orgId: org.orgId, workspaceId: org.a, locationId: l!.row.id, googleReviewName: `${l!.parent}/reviews/${uniq()}b`, reviewerDisplayName: "Angry Person", starRating: 1, comment: "ZQXONESTAR rude", createTime: now, updateTime: now },
    ]);
    useModel(async (req) => {
      calls.push({ system: req.system, user: req.user });
      return { text: "1. Whitening special\n2. Thanks to locals\n3. A\n4. B\n5. C\n6. D", inputTokens: 100, outputTokens: 50 };
    });
    const before = await usageCount();
    const r = await run<{ status: string; ideas: string[] }>(org.manager, "ai.postIdeas", { workspaceId: org.a, locationId: l!.row.id });
    expect(r.status).toBe("ok");
    expect(r.ideas).toHaveLength(5);
    expect(await usageCount()).toBe(before + 1);
    const { system, user } = calls[0]!;
    expect(user).toContain("Teeth whitening");
    expect(user).toContain("Friendly staff, short wait.");
    expect(user).not.toContain("ZQXONESTAR"); // 1-star reviews are not praise
    expect(user).toContain(`Upcoming occasions: ${occasionsLine("us", "UTC")}`); // US market, next 60 days
    expect(system + user).not.toContain("Surname");
    expect(system + user).not.toContain("Angry");
    expect(system).toMatch(/never mention any health or medical detail/i);
  });

  it("a healthcare client sends no review text at all", async () => {
    const [l] = await mkLocs(1);
    const now = new Date();
    await db.insert(reviews).values({ orgId: org.orgId, workspaceId: org.a, locationId: l!.row.id, googleReviewName: `${l!.parent}/reviews/${uniq()}`, starRating: 5, comment: "ZQXHEALTH my knee is better", createTime: now, updateTime: now });
    await db.insert(workspaceReplySettings).values({ orgId: org.orgId, workspaceId: org.a, packs: ["hipaa"] }).onConflictDoUpdate({ target: workspaceReplySettings.workspaceId, set: { packs: ["hipaa"] } });
    useModel(echo());
    await run(org.manager, "ai.draftPost", { workspaceId: org.a, locationId: l!.row.id });
    expect(calls[0]!.user).not.toContain("ZQXHEALTH");
    await db.update(workspaceReplySettings).set({ packs: [] }).where(eq(workspaceReplySettings.workspaceId, org.a));
  });

  it("holidays follow the client's market: an AU workspace gets the AU list, none of the US-only days", async () => {
    const [l] = await mkLocs(1);
    await db.update(workspaces).set({ timeZone: "Australia/Sydney" }).where(eq(workspaces.id, org.a));
    useModel(echo());
    await run(org.manager, "ai.draftPost", { workspaceId: org.a, locationId: l!.row.id });
    await db.update(workspaces).set({ timeZone: "UTC" }).where(eq(workspaces.id, org.a));
    const { system, user } = calls[0]!;
    expect(user).toContain(`Upcoming occasions: ${occasionsLine("au", "Australia/Sydney")}`);
    expect(user).not.toMatch(/Thanksgiving|Halloween|Veterans Day/);
    expect(system).toContain("Australia");
  });

  it("ai.draftPost passes the idea, returns Standard-length text, removes em dashes and warns U8.style", async () => {
    const [l] = await mkLocs(1);
    useModel(echo((t) => `${t} A seamless — visit.`));
    const d = await run<{ status: string; draft: string; warningRuleIds: string[] }>(org.manager, "ai.draftPost", { workspaceId: org.a, locationId: l!.row.id, idea: "Whitening special" });
    expect(calls[0]!.user).toContain("Idea: Whitening special");
    expect(d.status).toBe("ok");
    expect(d.draft).not.toContain("—");
    expect(d.draft).toContain("A seamless, visit.");
    expect(d.warningRuleIds).toContain("U8.style"); // "seamless" is a banned word; U8.style now runs on posts
  });

  it("a location of another client is not found; viewers are refused", async () => {
    const [l] = await mkLocs(1);
    useModel(echo());
    expect(await codeOf(run(org.manager, "ai.draftPost", { workspaceId: org.a, locationId: "00000000-0000-4000-8000-000000000001" }))).toMatch(/NOT_FOUND/);
    expect(await codeOf(run(org.viewerA, "ai.postIdeas", { workspaceId: org.a, locationId: l!.row.id }))).toMatch(/^FORBIDDEN/);
  });
});

describe("ai.draftPostVariants", () => {
  it("a 4-location send puts 4 distinct drafts in approval, each for its own location", async () => {
    const locs = await mkLocs(4);
    useModel(echo());
    const before = await usageCount();
    const out = await variants(locs.map((l) => l.row.id));
    expect(out.results.map((r) => r.outcome)).toEqual(["drafted", "drafted", "drafted", "drafted"]);
    expect(out.results.every((r) => r.postStatus === "pending_approval")).toBe(true);
    const rows = await db.select().from(posts).where(inArray(posts.id, out.results.map((r) => r.postId!)));
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.summary)).size).toBe(4);
    expect(rows.every((r) => r.status === "pending_approval")).toBe(true);
    const targets = await db.select().from(postTargets).where(inArray(postTargets.postId, rows.map((r) => r.id)));
    expect(targets).toHaveLength(4);
    for (const l of locs) {
      const t = targets.find((x) => x.locationId === l.row.id)!;
      expect(rows.find((r) => r.id === t.postId)!.summary).toContain(l.row.title!);
    }
    expect(await usageCount()).toBe(before + 4);
    // Later locations are told how the earlier posts began, and each gets its own opening style.
    expect(calls[1]!.user).toContain("Do not start like these");
    expect(new Set(calls.map((c) => /Open with[^\n]*/.exec(c.user)![0])).size).toBe(4);
  });

  it("removes em dashes and stores the U8.style warning on the post for the approver", async () => {
    const [l] = await mkLocs(1);
    useModel(echo((t) => `${t} We offer a seamless — visit.`));
    const out = await variants([l!.row.id]);
    expect(out.results[0]).toMatchObject({ outcome: "drafted", postStatus: "pending_approval" });
    expect(out.results[0]!.warningRuleIds).toContain("U8.style");
    const [p] = await db.select().from(posts).where(eq(posts.id, out.results[0]!.postId!));
    expect(p!.summary).not.toContain("—");
    expect(JSON.stringify(p!.guardrailResult)).toContain("U8.style");
    expect(p!.warningsAcknowledged).toBe(true);
  });

  it("a cap refusal mid-batch stops the rest, with results", async () => {
    const locs = await mkLocs(5);
    // Each call costs about 300_010 micro-USD. Cap 0.45 USD: calls 1 and 2 pass, call 3 is refused.
    await run(org.owner, "aiUsage.setClientCap", { workspaceId: org.a, monthlyCapUsd: 0.45 });
    const m = vi.fn(echo((t) => t, { i: 100, o: 600_000 }));
    useModel(m);
    const before = await usageCount();
    const out = await variants(locs.map((l) => l.row.id));
    expect(out.results.map((r) => r.outcome)).toEqual(["drafted", "drafted", "refused", "not_attempted", "not_attempted"]);
    expect(out.stoppedOverCap).toBe(true);
    expect(out.results[2]!.reason).toMatch(/monthly AI limit/);
    expect(out.results[3]!.reason).toMatch(/Stopped/);
    expect(m).toHaveBeenCalledTimes(2);
    expect(await usageCount()).toBe(before + 2);
    expect(out.counts).toMatchObject({ drafted: 2, refused: 1, notAttempted: 2 });
  });

  it("a failure on location 3 leaves 1 and 2 drafted and metered, and the run carries on", async () => {
    const locs = await mkLocs(4);
    let n = 0;
    useModel(async (req) => {
      calls.push({ system: req.system, user: req.user });
      if (++n === 3) throw new Error("boom");
      return { text: `Visit ${businessOf(req.user)} soon.`, inputTokens: 100, outputTokens: 50 };
    });
    const before = await usageCount();
    const out = await variants(locs.map((l) => l.row.id));
    expect(out.results.map((r) => r.outcome)).toEqual(["drafted", "drafted", "failed", "drafted"]);
    expect(out.results[2]!.reason).not.toContain("boom");
    expect(out.results[2]!.postId).toBeNull();
    expect(await usageCount()).toBe(before + 3);
    const targets = await db.select().from(postTargets).where(inArray(postTargets.locationId, locs.map((l) => l.row.id)));
    expect(targets.map((t) => t.locationId).sort()).toEqual([locs[0]!, locs[1]!, locs[3]!].map((l) => l.row.id).sort());
  });

  it("audit rows hold counts and ids only, never post or review text", async () => {
    const [l] = await mkLocs(1);
    const now = new Date();
    await db.insert(reviews).values({ orgId: org.orgId, workspaceId: org.a, locationId: l!.row.id, googleReviewName: `${l!.parent}/reviews/${uniq()}`, starRating: 5, comment: "ZQXREVIEWTEXT lovely", createTime: now, updateTime: now });
    useModel(echo());
    await variants([l!.row.id]);
    const all = JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.orgId, org.orgId)));
    expect(all).not.toContain(CANARY);
    expect(all).not.toContain("ZQXREVIEWTEXT");
    expect(JSON.stringify(await kit.auditRows(org.orgId, "ai.draft_posts"))).toContain('"drafted":1');
  });

  it("locations of another client are skipped; viewers and empty lists are refused", async () => {
    const [mine] = await mkLocs(1);
    const other = await org.mkLoc(org.b);
    useModel(echo());
    const out = await variants([mine!.row.id, other.row.id]);
    expect(out.results.map((r) => r.outcome)).toEqual(["drafted", "skipped"]);
    expect(await codeOf(variants([mine!.row.id], {}, org.viewerA))).toMatch(/^FORBIDDEN/);
    expect(await codeOf(variants([]))).toMatch(/INVALID_INPUT/);
  });
});
