import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { aiUsage, apiTokens, auditLog, createDb, mcpProposals, reviewReplies, reviews } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit, uniq, type Org } from "./testkit";
import { setAiTestOverrides } from "./ai/model";
import {
  getAssistantModel,
  setAssistantTestModel,
  type AiChatModel,
  type ChatBlock,
  type ChatRequest,
  type ChatResponse,
} from "./ai/assistant-model";
import { assistantToolsFor, runAssistantTurn } from "./ai/assistant";
import { ASSISTANT, ASSISTANT_TOOLS } from "./config/assistant";
import { actions } from "./actions";
import { applyProposal } from "./proposals";
import { hashApiToken, resolveNewTokenScopes } from "./apiTokens";
import { costMicroUsd } from "./ai/money";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: pg } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const { run } = kit;

let org: Org;
let loc: Awaited<ReturnType<Org["mkLoc"]>>;
let locB: Awaited<ReturnType<Org["mkLoc"]>>;
beforeAll(async () => {
  org = await kit.makeOrg();
  loc = await org.mkLoc(org.a);
  locB = await org.mkLoc(org.b);
});
afterAll(async () => {
  setAiTestOverrides({});
  setAssistantTestModel(null);
  vi.unstubAllGlobals();
  await kit.deactivateAll();
  await pg.end();
});

let seq = 0;
async function mkReview(workspaceId: string, locationId: string, parent: string, comment: string, o: Org = org) {
  const now = new Date();
  const [r] = await db
    .insert(reviews)
    .values({
      orgId: o.orgId,
      workspaceId,
      locationId,
      googleReviewName: `${parent}/reviews/${uniq()}-${seq++}`,
      reviewerDisplayName: "Pat Reviewer",
      starRating: 5,
      comment,
      createTime: now,
      updateTime: now,
    })
    .returning();
  return r!;
}

const CANARY_A = "ZQXALPHAREVIEW";
const CANARY_B = "ZQXBRAVOREVIEW";
const sent: ChatRequest[] = [];
const toolUse = (calls: { name: string; input: unknown }[]): ChatResponse => ({
  content: calls.map((c, i) => ({ type: "tool_use", id: `tu_${seq++}_${i}`, name: c.name, input: c.input })),
  stopReason: "tool_use",
  inputTokens: 1_000,
  outputTokens: 100,
});
const say = (text: string): ChatResponse => ({
  content: [{ type: "text", text }],
  stopReason: "end_turn",
  inputTokens: 1_000,
  outputTokens: 100,
});
/** A scripted chat model: step i answers call i (a function sees the request, so it can read tool results). */
const script =
  (steps: (ChatResponse | ((req: ChatRequest) => ChatResponse))[]): AiChatModel =>
  async (req) => {
    sent.push(structuredClone(req));
    const s = steps[Math.min(sent.length - 1, steps.length - 1)]!;
    return typeof s === "function" ? s(req) : s;
  };
const useModel = (m: AiChatModel, cap = "1000") => {
  setAiTestOverrides({ env: { AI_MONTHLY_BUDGET_USD: cap } });
  setAssistantTestModel(m);
};
const ask = (actor = org.manager, workspaceId = org.a, text = "draft replies for this week's unreplied reviews") =>
  runAssistantTurn(db, actor, { workspaceId, messages: [{ role: "user", text }] });
const resultsOf = (req: ChatRequest): ChatBlock[] =>
  req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : []));
const proposalRows = () => db.select().from(mcpProposals).where(eq(mcpProposals.orgId, org.orgId));

beforeEach(async () => {
  sent.length = 0;
  mock.calls.length = 0;
  await run(org.owner, "aiUsage.setClientCap", { workspaceId: org.a, monthlyCapUsd: null });
  vi.stubGlobal("fetch", () => {
    throw new Error("the real network must never be reached in tests");
  });
});

describe("tool list", () => {
  it("every allowed tool is a real action, and the model can never confirm its own proposal", () => {
    const names = new Set(actions.map((a) => a.name));
    for (const n of ASSISTANT_TOOLS) expect(names.has(n), n).toBe(true);
    expect(ASSISTANT_TOOLS.some((n) => n.startsWith("mcp.proposals"))).toBe(false);
    expect(ASSISTANT_TOOLS.some((n) => /publish|approve|delete/i.test(n))).toBe(false);
  });

  it("is filtered by what the signed-in role may call, with MCP's tool names and no dryRun field", () => {
    const owner = assistantToolsFor(org.owner).defs.map((t) => t.name);
    expect(owner).toContain("reviews_list_unreplied");
    expect(owner).toContain("reviewReplies_createDraft");
    const viewer = assistantToolsFor(org.viewerA).defs.map((t) => t.name);
    expect(viewer).toContain("reviews_list");
    expect(viewer).not.toContain("reviewReplies_createDraft");
    for (const t of assistantToolsFor(org.owner).defs) {
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(JSON.stringify(t.input_schema)).not.toContain("dryRun");
    }
  });
});

describe("Done when: draft replies for this week's unreplied reviews", () => {
  it("reads run, the draft becomes a proposal, and nothing is published or written", async () => {
    const r = await mkReview(org.a, loc.row.id, loc.parent, `Great visit ${CANARY_A}`);
    const DRAFT = "Thank you for visiting, we are glad it went well.";
    useModel(
      script([
        toolUse([{ name: "reviews_list", input: { workspaceId: org.a, replied: false } }]),
        (req) => {
          // The model really was shown the read result.
          expect(JSON.stringify(resultsOf(req))).toContain(CANARY_A);
          return toolUse([{ name: "reviewReplies_createDraft", input: { reviewId: r.id, body: DRAFT } }]);
        },
        say("I queued 1 reply for you to confirm."),
      ]),
    );
    const out = await ask();
    expect(out.status).toBe("ok");
    expect(out.reply).toBe("I queued 1 reply for you to confirm.");
    expect(out.tools).toEqual([
      { name: "reviews_list", ok: true },
      { name: "reviewReplies_createDraft", ok: true },
    ]);
    expect(out.proposals).toHaveLength(1);

    const rows = (await proposalRows()).filter((p) => p.id === out.proposals[0]!.proposalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "reviewReplies.createDraft", status: "pending", userId: org.manager.userId });

    // Nothing was written: no reply row, no Google reply, nothing sent to Google.
    expect(await db.select().from(reviewReplies).where(eq(reviewReplies.reviewId, r.id))).toHaveLength(0);
    const [after] = await db.select().from(reviews).where(eq(reviews.id, r.id));
    expect(after!.replyComment).toBeNull();
    expect(mock.calls.filter((c) => /Reply|createLocalPost|patch|update/i.test(c.method))).toEqual([]);
    expect(await db.select().from(reviewReplies).where(eq(reviewReplies.orgId, org.orgId))).toHaveLength(0);

    // Metered against the client, settled to the real cost (1000 in, 100 out per call, three calls).
    const usage = await db.select().from(aiUsage).where(and(eq(aiUsage.workspaceId, org.a), eq(aiUsage.action, "ai.assistant")));
    expect(usage.length).toBeGreaterThanOrEqual(3);
    expect(usage.every((u) => u.inputTokens === 1_000 && u.purpose === "assistant")).toBe(true);
    expect(out.costMicroUsd).toBe(3 * costMicroUsd("claude-haiku-5-5", 1_000, 100));
  });

  it("a person confirming the proposal is what writes the draft (still not published)", async () => {
    const r = await mkReview(org.a, loc.row.id, loc.parent, "Confirm me");
    useModel(
      script([
        toolUse([{ name: "reviewReplies_createDraft", input: { reviewId: r.id, body: "Thanks so much." } }]),
        say("Queued."),
      ]),
    );
    const out = await ask();
    const id = out.proposals[0]!.proposalId;
    // The web path: the same signed-in person, no token, applies it.
    const applied = await db.transaction((tx) =>
      applyProposal({ tx, db, actor: org.manager, audit: async () => {}, afterCommit: () => {} }, id),
    );
    expect(applied.status).toBe("applied");
    const reply = await db.select().from(reviewReplies).where(eq(reviewReplies.reviewId, r.id));
    expect(reply).toHaveLength(1);
    expect(reply[0]!.status).toBe("draft");
    expect(mock.calls.filter((c) => /Reply/.test(c.method))).toEqual([]);
  });

  it("an own_flow write that would run directly over MCP is still only a proposal", async () => {
    // reviewReplies.createDraft is approval own_flow: executeToolCall would execute it.
    expect(actions.find((a) => a.name === "reviewReplies.createDraft")!.approval).toBe("own_flow");
    const r = await mkReview(org.a, loc.row.id, loc.parent, "Own flow");
    useModel(script([toolUse([{ name: "reviewReplies_createDraft", input: { reviewId: r.id, body: "Hi." } }]), say("ok")]));
    await ask();
    expect(await db.select().from(reviewReplies).where(eq(reviewReplies.reviewId, r.id))).toHaveLength(0);
  });

  it("uses one hidden token per person for its proposals", async () => {
    const r = await mkReview(org.a, loc.row.id, loc.parent, "Token");
    useModel(script([toolUse([{ name: "reviewReplies_createDraft", input: { reviewId: r.id, body: "Hi." } }]), say("ok")]));
    await ask();
    await ask();
    const t = await db.select().from(apiTokens).where(and(eq(apiTokens.userId, org.manager.userId), eq(apiTokens.name, ASSISTANT.tokenName)));
    expect(t).toHaveLength(1);
  });

  it("keeps using a hidden token created under the old name, and names new ones Ask OpenGMB assistant", async () => {
    expect(ASSISTANT.tokenName).toBe("Ask OpenGMB assistant");
    expect(ASSISTANT.legacyTokenNames).toEqual(["Ask SynGMB assistant"]);
    const other = await kit.makeOrg();
    const otherLoc = await other.mkLoc(other.a);
    // A hidden token as A6 created it before the rename (scopes as assistantActor writes them).
    const [old] = await db
      .insert(apiTokens)
      .values({
        orgId: other.orgId,
        userId: other.manager.userId,
        name: "Ask SynGMB assistant",
        scopes: resolveNewTokenScopes(other.manager),
        tokenHash: hashApiToken(`legacy-${uniq()}`),
      })
      .returning();
    const r = await mkReview(other.a, otherLoc.row.id, otherLoc.parent, "Legacy token", other);
    useModel(script([toolUse([{ name: "reviewReplies_createDraft", input: { reviewId: r.id, body: "Hi." } }]), say("ok")]));
    await ask(other.manager, other.a);
    const tokens = await db.select().from(apiTokens).where(eq(apiTokens.userId, other.manager.userId));
    expect(tokens.map((t) => t.name)).toEqual(["Ask SynGMB assistant"]);
    const props = await db.select().from(mcpProposals).where(eq(mcpProposals.orgId, other.orgId));
    expect(props.length).toBeGreaterThan(0);
    expect(props.every((p) => p.tokenId === old!.id)).toBe(true);
  });
});

describe("privacy", () => {
  it("audits user, client, tool names, counts and cost, never text", async () => {
    const r = await mkReview(org.a, loc.row.id, loc.parent, `Secret ${CANARY_A}`);
    useModel(
      script([
        toolUse([{ name: "reviews_get", input: { id: r.id } }]),
        say(`The review says Secret ${CANARY_A}`),
      ]),
    );
    const known = new Set((await kit.auditRows(org.orgId, "ai.assistant_turn")).map((x) => x.id));
    await ask(org.manager, org.a, `please tell me about ${CANARY_B}`);
    // This turn's own row: the one that did not exist before the call.
    const fresh = (await kit.auditRows(org.orgId, "ai.assistant_turn")).filter((x) => !known.has(x.id));
    expect(fresh).toHaveLength(1);
    const row = fresh[0]!;
    expect(row.actorUserId).toBe(org.manager.userId);
    expect(row.after).toMatchObject({ workspaceId: org.a, toolCalls: 1, toolNames: ["reviews_get"], proposals: 0 });
    const all = JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.orgId, org.orgId)));
    expect(all).not.toContain(CANARY_A);
    expect(all).not.toContain(CANARY_B);
  });
});

describe("tenant isolation", () => {
  it("a client viewer cannot reach another client's data through the assistant", async () => {
    const mine = await mkReview(org.a, loc.row.id, loc.parent, `Mine ${CANARY_A}`);
    const theirs = await mkReview(org.b, locB.row.id, locB.parent, `Theirs ${CANARY_B}`);
    useModel(
      script([
        toolUse([
          { name: "reviews_list", input: { workspaceId: org.b } }, // another client, named outright
          { name: "reviews_get", input: { id: theirs.id } }, // another client's review by id
          { name: "reviewReplies_createDraft", input: { reviewId: mine.id, body: "x" } }, // not a viewer tool
          { name: "mcp_proposals_apply", input: { proposalId: "00000000-0000-4000-8000-000000000000" } },
        ]),
        say("Done."),
      ]),
    );
    const out = await ask(org.viewerA, org.a);
    expect(out.tools.every((t) => !t.ok)).toBe(true);
    expect(out.proposals).toHaveLength(0);
    const second = JSON.stringify(sent[1]!.messages);
    expect(second).not.toContain(CANARY_B);
    expect(second).not.toContain("Theirs");
    // The viewer's own client still works.
    sent.length = 0;
    useModel(script([toolUse([{ name: "reviews_get", input: { id: mine.id } }]), say("ok")]));
    const ok = await ask(org.viewerA, org.a);
    expect(ok.tools).toEqual([{ name: "reviews_get", ok: true }]);
    expect(JSON.stringify(sent[1]!.messages)).toContain(CANARY_A);
  });

  it("refuses a chat about a client the person cannot see", async () => {
    useModel(script([say("hi")]));
    expect(await codeOf(ask(org.viewerA, org.b))).toBe("FORBIDDEN");
    expect(sent).toHaveLength(0);
  });
});

describe("limits", () => {
  it("the 9th tool call in a turn does not run", async () => {
    const nine = Array.from({ length: ASSISTANT.maxToolCallsPerTurn + 1 }, () => ({
      name: "workspaces_list",
      input: {},
    }));
    useModel(script([toolUse(nine), say("partial")]));
    const out = await ask();
    expect(out.tools).toHaveLength(ASSISTANT.maxToolCallsPerTurn);
    expect(out.status).toBe("tool_limit");
    const results = resultsOf(sent[1]!);
    expect(results).toHaveLength(ASSISTANT.maxToolCallsPerTurn + 1);
    expect(results.at(-1)).toMatchObject({ is_error: true });
    expect(String(results.at(-1)!.content)).toContain("LIMIT");
  });

  it("stops after the model-call limit when the model keeps asking for tools", async () => {
    useModel(script([toolUse([{ name: "workspaces_list", input: {} }])]));
    const out = await ask();
    expect(out.status).toBe("tool_limit");
    expect(sent.length).toBe(ASSISTANT.maxModelCallsPerTurn);
  });

  it("refuses cleanly before calling the model when the platform cap is reached", async () => {
    useModel(script([say("never")]), "0");
    const out = await ask();
    expect(out).toMatchObject({ status: "budget", budgetScope: "platform", reply: "" });
    expect(sent).toHaveLength(0);
  });

  it("refuses cleanly when the client's own cap is reached", async () => {
    await run(org.owner, "aiUsage.setClientCap", { workspaceId: org.a, monthlyCapUsd: 0.0001 });
    useModel(script([say("never")]));
    const out = await ask();
    expect(out).toMatchObject({ status: "budget", budgetScope: "client" });
    expect(sent).toHaveLength(0);
    const other = await ask(org.owner, org.b);
    expect(other.status).toBe("ok"); // another client is unaffected
  });

  it("a cap reached mid-turn stops the loop and keeps what already ran", async () => {
    const r = await mkReview(org.a, loc.row.id, loc.parent, "Mid");
    await run(org.owner, "aiUsage.setClientCap", { workspaceId: org.a, monthlyCapUsd: null });
    setAiTestOverrides({ env: { AI_MONTHLY_BUDGET_USD: "1000" } });
    let n = 0;
    setAssistantTestModel(async (req) => {
      sent.push(req);
      if (n++ === 0) {
        // After the first call, set a cap the next reservation would pass.
        await run(org.owner, "aiUsage.setClientCap", { workspaceId: org.a, monthlyCapUsd: 0.0001 });
        return toolUse([{ name: "reviews_get", input: { id: r.id } }]);
      }
      return say("never");
    });
    const out = await ask();
    expect(out.status).toBe("budget");
    expect(out.tools).toEqual([{ name: "reviews_get", ok: true }]);
    expect(sent).toHaveLength(1);
  });

  it("a failed AI call is reported and not billed", async () => {
    useModel(async () => {
      throw new Error("boom");
    });
    const known = new Set((await db.select().from(aiUsage).where(eq(aiUsage.workspaceId, org.a))).map((u) => u.id));
    const out = await ask();
    expect(out.status).toBe("failed");
    // This turn's own usage row: the one that did not exist before the call.
    const fresh = (await db.select().from(aiUsage).where(eq(aiUsage.workspaceId, org.a))).filter((u) => !known.has(u.id));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.costMicroUsd).toBe(0);
  });

  it("is not configured without a key", async () => {
    setAssistantTestModel(null);
    setAiTestOverrides({ env: {} });
    expect((await ask()).status).toBe("not_configured");
  });

  it("rejects a conversation that is too long or ends with an assistant message", async () => {
    useModel(script([say("x")]));
    const long = Array.from({ length: ASSISTANT.maxUserMessages + 1 }, () => ({ role: "user" as const, text: "hi" }));
    expect(await codeOf(runAssistantTurn(db, org.manager, { workspaceId: org.a, messages: long }))).toBe("INVALID_INPUT");
    expect(
      await codeOf(runAssistantTurn(db, org.manager, { workspaceId: org.a, messages: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }] })),
    ).toBe("INVALID_INPUT");
  });
});

describe("Anthropic client", () => {
  it("sends tools and returns tool_use blocks, tokens and stop reason unchanged; errors carry the status only", async () => {
    setAssistantTestModel(null);
    setAiTestOverrides({ env: { ANTHROPIC_API_KEY: "sk-test" } });
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: { body: string; headers: Record<string, string> }) => {
      bodies.push(JSON.parse(init.body));
      expect(init.headers["x-api-key"]).toBe("sk-test");
      return new Response(
        JSON.stringify({
          content: [{ type: "tool_use", id: "t1", name: "reviews_list", input: {} }],
          stop_reason: "tool_use",
          usage: { input_tokens: 7, output_tokens: 3 },
        }),
        { status: 200 },
      );
    });
    const m = getAssistantModel()!;
    const res = await m({
      model: "claude-haiku-5-5",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "reviews_list", description: "d", input_schema: { type: "object" } }],
      maxTokens: 10,
      timeoutMs: 1_000,
    });
    expect(res).toMatchObject({ stopReason: "tool_use", inputTokens: 7, outputTokens: 3 });
    expect(res.content[0]).toMatchObject({ type: "tool_use", name: "reviews_list" });
    expect(bodies[0]).toMatchObject({ model: "claude-haiku-5-5", tool_choice: { type: "auto" } });
    expect((bodies[0]!.tools as unknown[]).length).toBe(1);
    vi.stubGlobal("fetch", async () => new Response("secret body", { status: 529 }));
    await expect(m({ model: "claude-haiku-5-5", system: "", messages: [], tools: [], maxTokens: 1, timeoutMs: 100 })).rejects.toThrow(/HTTP 529/);
  });
});
