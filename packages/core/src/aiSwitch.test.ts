import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, reviews } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit, uniq, type Org } from "./testkit";
import { setAiTestOverrides, type AiModel } from "./ai/model";
import { AI_OFF_MESSAGE } from "./ai/switch";
import type { Actor } from "./actor";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: pg } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
const { run } = kit;

let org: Org;
let loc: Awaited<ReturnType<Org["mkLoc"]>>;
const sent: string[] = [];
const model: AiModel = async (req) => {
  sent.push(req.user);
  return { text: "Thank you for the kind words.", inputTokens: 100, outputTokens: 40 };
};

beforeAll(async () => {
  org = await kit.makeOrg();
  loc = await org.mkLoc(org.a);
  setAiTestOverrides({ model, env: { AI_MONTHLY_BUDGET_USD: "1000" } });
});
afterAll(async () => {
  setAiTestOverrides({});
  await kit.deactivateAll();
  await pg.end();
});

async function review() {
  const now = new Date();
  const [r] = await db
    .insert(reviews)
    .values({
      orgId: org.orgId,
      workspaceId: org.a,
      locationId: loc.row.id,
      googleReviewName: `${loc.parent}/reviews/${uniq()}`,
      reviewerDisplayName: "Pat Reviewer",
      starRating: 5,
      comment: "ZQXREVIEWTEXT friendly team",
      createTime: now,
      updateTime: now,
    })
    .returning();
  return r!;
}
const state = (a: Actor) => run<{ aiEnabled: boolean; noticeSeen: boolean }>(a, "aiSwitch.get", {});

describe("account AI switch", () => {
  it("is on by default and an owner can switch it off and on", async () => {
    expect((await state(org.owner)).aiEnabled).toBe(true);
    expect((await run<{ aiEnabled: boolean }>(org.owner, "aiSwitch.update", { aiEnabled: false })).aiEnabled).toBe(false);
    expect((await state(org.manager)).aiEnabled).toBe(false);
  });

  it("while off, an AI action refuses with the plain message and nothing reaches the model", async () => {
    const r = await review();
    const before = sent.length;
    await expect(run(org.manager, "ai.draftReply", { reviewId: r.id })).rejects.toThrow(AI_OFF_MESSAGE);
    expect(sent.length).toBe(before);
    expect(sent.join(" ")).not.toContain("ZQXREVIEWTEXT");
  });

  it("while off, ai.draftText refuses too", async () => {
    const before = sent.length;
    await expect(run(org.manager, "ai.draftText", { workspaceId: org.a, purpose: "post", sourceText: "ZQXTOPIC" })).rejects.toThrow(AI_OFF_MESSAGE);
    expect(sent.length).toBe(before);
    expect(sent.join(" ")).not.toContain("ZQXTOPIC");
  });

  it("turned back on, the same action works", async () => {
    await run(org.owner, "aiSwitch.update", { aiEnabled: true });
    const r = await review();
    const d = await run<{ status: string }>(org.manager, "ai.draftReply", { reviewId: r.id });
    expect(d.status).toBe("ok");
    expect(sent.join(" ")).toContain("ZQXREVIEWTEXT");
  });

  it("only an owner changes it, and an API token cannot", async () => {
    expect(await codeOf(run(org.manager, "aiSwitch.update", { aiEnabled: false }))).toBe("FORBIDDEN");
    const token: Actor = { ...org.owner, surface: "mcp", actorType: "api_token" };
    expect(await codeOf(run(token, "aiSwitch.update", { aiEnabled: false }))).toBe("FORBIDDEN");
    expect((await state(org.owner)).aiEnabled).toBe(true);
  });
});

describe("one-time AI notice", () => {
  it("is stored per person and survives repeat calls", async () => {
    expect((await state(org.manager)).noticeSeen).toBe(false);
    expect((await run<{ noticeSeen: boolean }>(org.manager, "aiNotice.acknowledge", {})).noticeSeen).toBe(true);
    expect((await run<{ noticeSeen: boolean }>(org.manager, "aiNotice.acknowledge", {})).noticeSeen).toBe(true);
    expect((await state(org.manager)).noticeSeen).toBe(true);
    expect((await state(org.owner)).noticeSeen).toBe(false);
  });
});
