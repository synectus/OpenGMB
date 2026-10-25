import { describe, expect, it } from "vitest";
import {
  BULK_AI_MAX, BULK_DRAFT_MAX, agentPrompt, aiOutcomeLine, aiSummaryText, bulkCounts, bulkRow, createDraftsSequentially, draftLabel,
  markDrafted, pruneSelection, ratingsFromParam, summaryText, toggleAll, toggleOne, visibleRows,
  type AiItem, type AiResult, type UnrepliedItem,
} from "./bulk-reply";
import { makeTimeFormat } from "./time-format";

const utc = makeTimeFormat({ zones: [], workspaceId: null });
const ist = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

const item = (o: Partial<UnrepliedItem> & { id: string }): UnrepliedItem =>
  ({
    googleReviewName: "n", location: { id: "l", name: "Rivermoor South" },
    reviewer: { displayName: "Maria G.", isAnonymous: false }, rating: 2,
    comment: "Waited almost 90 minutes past my appointment time and nobody told us why.",
    createTime: "2026-10-17T10:00:00.000Z", updateTime: "2026-10-17T10:00:00.000Z", reply: null,
    replyAllowed: true, skipReason: null, openReply: null, ...o,
  }) as UnrepliedItem;

describe("rows", () => {
  it("a normal row can be replied to", () => {
    const r = bulkRow(item({ id: "a" }), utc);
    expect(r).toMatchObject({ id: "a", selectable: true, reviewer: "Maria G.", where: "Rivermoor South · 2026-10-17", status: { tone: "good", label: "Can reply" } });
  });
  it("the date is the review's day in the client's zone and format", () => {
    expect(bulkRow(item({ id: "a", createTime: "2026-10-17T22:00:00.000Z" }), ist).where).toBe("Rivermoor South · 18/10/2026");
  });
  it("anonymous reviewers and long text", () => {
    const r = bulkRow(item({ id: "a", reviewer: { displayName: null, isAnonymous: true }, comment: "x".repeat(300) }), utc);
    expect(r.reviewer).toBe("Anonymous");
    expect(r.text.length).toBeLessThanOrEqual(121);
    expect(r.text.endsWith("…")).toBe(true);
    expect(bulkRow(item({ id: "b", comment: null }), utc).text).toBe("No written review.");
  });
  it("a policy skip is not selectable and says why", () => {
    const r = bulkRow(item({ id: "a", replyAllowed: false, skipReason: "Healthcare profile: replies to positive reviews are off" }), utc);
    expect(r).toMatchObject({ selectable: false, status: { tone: "neutral", label: "Skipped: Healthcare profile: replies to positive reviews are off" } });
  });
  it("a reply Google rejected is selectable and red", () => {
    const r = bulkRow(item({ id: "a", reply: { comment: "c", updateTime: null, state: "REJECTED", policyViolation: null } }), utc);
    expect(r).toMatchObject({ selectable: true, status: { tone: "bad", label: "Reply rejected by Google, needs a new reply" } });
  });
});

describe("counts, visibility and selection", () => {
  const rows = [
    bulkRow(item({ id: "a" }), utc),
    bulkRow(item({ id: "b" }), utc),
    bulkRow(item({ id: "c", replyAllowed: false, skipReason: "x" }), utc),
  ];
  it("counts displayed, can reply, skipped", () => {
    expect(bulkCounts(rows)).toEqual({ displayed: 3, canReply: 2, skipped: 1 });
    expect(bulkCounts(visibleRows(rows, false))).toEqual({ displayed: 2, canReply: 2, skipped: 0 });
  });
  it("select all picks only selectable rows and toggles back", () => {
    expect(toggleAll([], rows)).toEqual(["a", "b"]);
    expect(toggleAll(["a", "b"], rows)).toEqual([]);
    expect(toggleOne(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleOne(["a", "b"], "a")).toEqual(["b"]);
  });
  it("pruneSelection drops ids that left the list or stopped being selectable", () => {
    expect(pruneSelection(["a", "c", "zzz"], rows)).toEqual(["a"]);
  });
  it("markDrafted makes rows unselectable with a note", () => {
    const out = markDrafted(rows, ["a"]);
    expect(out[0]).toMatchObject({ selectable: false, status: { tone: "neutral", label: "Draft created: open it in the Inbox" } });
    expect(out[1]!.selectable).toBe(true);
  });
  it("labels", () => {
    expect(draftLabel(1)).toBe("Create 1 draft");
    expect(draftLabel(8)).toBe("Create 8 drafts");
    expect(draftLabel(0)).toBe("Create drafts");
  });
  it("rating param", () => {
    expect(ratingsFromParam("1-3")).toEqual([1, 2, 3]);
    expect(ratingsFromParam("1-2")).toEqual([1, 2]);
    expect(ratingsFromParam("5")).toBeUndefined();
    expect(ratingsFromParam(undefined)).toBeUndefined();
  });
});

describe("createDraftsSequentially", () => {
  const ok = (data: unknown = {}) => Promise.resolve({ ok: true as const, data });
  const bad = (code: string, message: string) => Promise.resolve({ ok: false as const, error: { code, message } });
  it("runs one after another and keeps going after a failure", async () => {
    const order: string[] = [];
    const out = await createDraftsSequentially(["a", "b", "c"], {
      render: (id) => {
        order.push(`render:${id}`);
        return id === "b" ? bad("INVALID_INPUT", "reviewer name unavailable") : ok({ body: `Hi ${id}` });
      },
      createDraft: (id, body) => {
        order.push(`draft:${id}:${body}`);
        return id === "c" ? bad("CONFLICT", "Review already has an open reply revision") : ok();
      },
    });
    expect(order).toEqual(["render:a", "draft:a:Hi a", "render:b", "render:c", "draft:c:Hi c"]);
    expect(out).toEqual([
      { reviewId: "a", status: "created" },
      { reviewId: "b", status: "skipped", reason: "INVALID_INPUT: reviewer name unavailable" },
      { reviewId: "c", status: "skipped", reason: "CONFLICT: Review already has an open reply revision" },
    ]);
    expect(summaryText(out)).toBe("Created 1 draft. 2 skipped.");
  });
  it("a thrown request becomes a skipped row, and the batch is capped", async () => {
    const out = await createDraftsSequentially(["a"], { render: () => { throw new Error("x"); }, createDraft: () => ok() });
    expect(out).toEqual([{ reviewId: "a", status: "skipped", reason: "INTERNAL: request failed" }]);
    const many = Array.from({ length: BULK_DRAFT_MAX + 5 }, (_, i) => String(i));
    const done = await createDraftsSequentially(many, { render: () => ok({ body: "b" }), createDraft: () => ok() });
    expect(done).toHaveLength(BULK_DRAFT_MAX);
  });
});

describe("agentPrompt", () => {
  it("carries ids and rules, never review text", () => {
    const text = agentPrompt({ workspaceName: "Rivermoor Pain Clinic", ids: ["id-1", "id-2"] });
    expect(text).toContain("Rivermoor Pain Clinic");
    expect(text).toContain("- id-1");
    expect(text).toContain("- id-2");
    expect(text).toContain("reviewReplies_createDraft");
    expect(text).toMatch(/Do not call reviewReplies_submit, reviewReplies_approve or reviewReplies_publish/);
    expect(text).toContain("(2)");
  });
});

describe("AI draft results", () => {
  const ai = (o: Partial<AiItem>): AiItem => ({ reviewId: "r", outcome: "drafted", replyStatus: "pending_approval", reason: null, blockedRuleIds: [], warningRuleIds: [], ...o });
  it("says what happened to each review in plain words", () => {
    expect(aiOutcomeLine(ai({}))).toBe("Drafted, waiting for approval");
    expect(aiOutcomeLine(ai({ warningRuleIds: ["U8.style"] }))).toBe("Drafted, waiting for approval. Check: Uses wording that reads as AI-written or stock");
    expect(aiOutcomeLine(ai({ replyStatus: "draft", warningRuleIds: ["U8.style"] }))).toBe("Saved as a draft, not sent for approval. A person must read these warnings first: Uses wording that reads as AI-written or stock");
    expect(aiOutcomeLine(ai({ outcome: "blocked", blockedRuleIds: ["U7.url", "R6.duplicate"] }))).toBe("Blocked by the guardrails: Contains a link, Same as a recent reply");
    expect(aiOutcomeLine(ai({ outcome: "refused", reason: "this client's monthly AI limit is reached" }))).toContain("monthly AI limit");
    expect(aiOutcomeLine(ai({ outcome: "skipped", reason: "It already has a reply." }))).toBe("Skipped: It already has a reply.");
    expect(aiOutcomeLine(ai({ outcome: "not_attempted", reason: "Stopped" }))).toBe("Not tried: Stopped");
  });
  it("the summary counts a refusal and the rest of the run as not drafted", () => {
    const r: AiResult = { results: [], stoppedOverCap: true, counts: { drafted: 2, blocked: 1, refused: 1, skipped: 3, failed: 0, notAttempted: 2 } };
    expect(aiSummaryText(r)).toBe("AI drafted 2 and sent them for approval. Blocked 1, skipped 3, not drafted 3, failed 0.");
  });
  it("matches the cap core enforces", () => {
    expect(BULK_AI_MAX).toBe(20);
  });
});
