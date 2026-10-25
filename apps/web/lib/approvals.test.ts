import { describe, expect, it, vi } from "vitest";
import {
  actionForKey,
  adjacentKey,
  afterActionKey,
  ageLabel,
  approvableKeys,
  approvalsHref,
  approveLabel,
  approveSequentially,
  autoApproveChipText,
  bulkBlockReason,
  fieldLabel,
  formatChangeValue,
  formatApprovalTime,
  inTab,
  isTypingTarget,
  inLocation,
  itemKey,
  locationOptions,
  parseItemKey,
  parseTab,
  pruneSelection,
  tabCount,
  toggleAll,
  toggleKey,
  type ApprovalItem,
} from "./approvals";
import { makeTimeFormat } from "./time-format";

const utc = makeTimeFormat({ zones: [], workspaceId: null });
const ist = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";

const item = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  type: "reply",
  id: ID1,
  workspaceId: "w",
  workspaceName: "W",
  locationNames: ["L"],
  submittedAt: "2026-10-01T09:00:00.000Z",
  title: "Reply to a 2★ review",
  text: "x",
  postId: null,
  reviewId: null,
  review: null,
  topicType: null,
  guardrail: { blocked: false, warnings: 0, warningsAcknowledged: false },
  provenance: { createdSurface: "ui", createdByName: "Ana" },
  can: { approve: true, reject: true },
  ...over,
});

describe("tabs", () => {
  it("parseTab falls back to all", () => {
    expect(parseTab("reply")).toBe("reply");
    expect(parseTab("changeset")).toBe("changeset");
    expect(parseTab("postedit")).toBe("postedit");
    expect(parseTab("proposal")).toBe("all");
    expect(parseTab(undefined)).toBe("all");
  });
  it("inTab filters by type and tabCount reads the totals", () => {
    const items = [item({ id: ID1 }), item({ id: ID2, type: "post" })];
    expect(inTab(items, "all")).toHaveLength(2);
    expect(inTab(items, "post").map((i) => i.id)).toEqual([ID2]);
    const counts = { reply: 1, post: 1, changeset: 0, postedit: 3, total: 5 };
    expect(tabCount(counts, "all")).toBe(5);
    expect(tabCount(counts, "postedit")).toBe(3);
    expect(tabCount(counts, "changeset")).toBe(0);
  });
});

describe("item keys and hrefs", () => {
  it("round-trips type:id and rejects anything else", () => {
    expect(itemKey({ type: "post", id: ID1 })).toBe(`post:${ID1}`);
    expect(parseItemKey(`changeset:${ID1}`)).toEqual({ type: "changeset", id: ID1 });
    expect(parseItemKey(`postedit:${ID1}`)).toEqual({ type: "postedit", id: ID1 });
    expect(parseItemKey(`proposal:${ID1}`)).toBeNull();
    expect(parseItemKey("reply:not-a-uuid")).toBeNull();
    expect(parseItemKey("reply")).toBeNull();
    expect(parseItemKey(undefined)).toBeNull();
  });
  it("approvalsHref keeps only what is set", () => {
    expect(approvalsHref({})).toBe("/approvals");
    expect(approvalsHref({ tab: "all" })).toBe("/approvals");
    expect(approvalsHref({ tab: "reply" })).toBe("/approvals?tab=reply");
    const u = new URL(approvalsHref({ tab: "post", ws: ID2, item: `post:${ID1}` }), "http://x");
    expect(u.searchParams.get("tab")).toBe("post");
    expect(u.searchParams.get("ws")).toBe(ID2);
    expect(u.searchParams.get("item")).toBe(`post:${ID1}`);
  });
});

describe("bulk rules", () => {
  it("a plain item you may approve is ready", () => {
    expect(bulkBlockReason(item())).toBeNull();
  });
  it("canary: each reason that blocks bulk approval is reported", () => {
    expect(bulkBlockReason(item({ can: { approve: false, reject: false } }))).toMatch(/cannot approve/);
    expect(
      bulkBlockReason(item({ guardrail: { blocked: true, warnings: 0, warningsAcknowledged: false } })),
    ).toMatch(/Blocked/);
    expect(
      bulkBlockReason(item({ guardrail: { blocked: false, warnings: 2, warningsAcknowledged: false } })),
    ).toMatch(/warnings nobody acknowledged/);
    // acknowledged warnings are fine
    expect(
      bulkBlockReason(item({ guardrail: { blocked: false, warnings: 2, warningsAcknowledged: true } })),
    ).toBeNull();
  });
  it("selection only ever holds ready items", () => {
    const ready = item({ id: ID1 });
    const warned = item({
      id: ID2,
      guardrail: { blocked: false, warnings: 1, warningsAcknowledged: false },
    });
    const items = [ready, warned];
    expect(approvableKeys(items)).toEqual([itemKey(ready)]);
    // a key that is no longer ready (or no longer there) is dropped
    expect(pruneSelection([itemKey(ready), itemKey(warned), `reply:${ID3}`], items)).toEqual([
      itemKey(ready),
    ]);
    expect(toggleKey([], "a")).toEqual(["a"]);
    expect(toggleKey(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleAll([], items)).toEqual([itemKey(ready)]);
    expect(toggleAll([itemKey(ready)], items)).toEqual([]);
    expect(toggleAll([], [warned])).toEqual([]);
    expect(approveLabel(3)).toBe("Approve 3");
  });
});

describe("approveSequentially", () => {
  it("approves one at a time, in order, and reports each failure as CODE: message", async () => {
    const items = [
      item({ id: ID1, type: "reply", title: "first" }),
      item({ id: ID2, type: "post", title: "second" }),
      item({ id: ID3, type: "changeset", title: "third" }),
    ];
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const approve = vi.fn(async (type: string, id: string) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await Promise.resolve();
      order.push(`${type}:${id}`);
      running--;
      if (type === "post") return { ok: false as const, error: { code: "CONFLICT", message: "gone" } };
      return { ok: true as const };
    });
    const out = await approveSequentially(items, approve);
    expect(order).toEqual([`reply:${ID1}`, `post:${ID2}`, `changeset:${ID3}`]);
    expect(maxRunning).toBe(1);
    expect(out.approved).toEqual([`reply:${ID1}`, `changeset:${ID3}`]);
    expect(out.errors).toEqual([
      { key: `post:${ID2}`, title: "second", message: "CONFLICT: gone" },
    ]);
  });
  it("a thrown request becomes an error and the run continues", async () => {
    const out = await approveSequentially(
      [item({ id: ID1 }), item({ id: ID2 })],
      async (_t, id) => {
        if (id === ID1) throw new Error("network");
        return { ok: true as const };
      },
    );
    expect(out.approved).toEqual([`reply:${ID2}`]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]!.message).toBe("INTERNAL: request failed");
  });
});

describe("keyboard", () => {
  const press = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
    ({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  it("maps A S J K, either case", () => {
    expect(actionForKey(press("a"), false)).toBe("approve");
    expect(actionForKey(press("A"), false)).toBe("approve");
    expect(actionForKey(press("s"), false)).toBe("sendBack");
    expect(actionForKey(press("j"), false)).toBe("next");
    expect(actionForKey(press("k"), false)).toBe("prev");
    expect(actionForKey(press("x"), false)).toBeNull();
  });
  it("ignores typing, and any chord (cmd-K belongs to the command palette)", () => {
    expect(actionForKey(press("a"), true)).toBeNull();
    expect(actionForKey(press("k", { metaKey: true }), false)).toBeNull();
    expect(actionForKey(press("k", { ctrlKey: true }), false)).toBeNull();
    expect(actionForKey(press("a", { altKey: true }), false)).toBeNull();
  });
  it("isTypingTarget: inputs, textareas, selects and contenteditable", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "textarea" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
  it("isTypingTarget: checkbox and radio inputs are not typing", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT", type: "radio" })).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT", type: "text" })).toBe(true);
  });
  it("adjacentKey walks the list and stops at the ends", () => {
    const keys = ["a", "b", "c"];
    expect(adjacentKey(keys, "a", 1)).toBe("b");
    expect(adjacentKey(keys, "c", 1)).toBeNull();
    expect(adjacentKey(keys, "a", -1)).toBeNull();
    expect(adjacentKey(keys, null, 1)).toBe("a");
    expect(adjacentKey([], "a", 1)).toBeNull();
  });
  it("afterActionKey prefers the next item, then the previous, then none", () => {
    expect(afterActionKey(["a", "b", "c"], "b")).toBe("c");
    expect(afterActionKey(["a", "b", "c"], "c")).toBe("b");
    expect(afterActionKey(["a"], "a")).toBeNull();
  });
});

describe("auto-approve chip text", () => {
  it("is null when no workspace has the rule", () => {
    expect(autoApproveChipText([])).toBeNull();
    expect(autoApproveChipText([null, null])).toBeNull();
  });
  it("names the actual rule and counts the workspaces", () => {
    expect(autoApproveChipText([5])).toBe("Auto-approve 5★ is on in 1 client");
    expect(autoApproveChipText([5, null, 5])).toBe("Auto-approve 5★ is on in 2 clients");
    expect(autoApproveChipText([4])).toBe("Auto-approve 4★ and up is on in 1 client");
    expect(autoApproveChipText([4, 5])).toBe("Auto-approve 4★ or 5★ is on in 2 clients");
  });
});

describe("formatting", () => {
  it("formatChangeValue handles empty, text, numbers and objects", () => {
    expect(formatChangeValue(null)).toBe("Not set");
    expect(formatChangeValue(undefined)).toBe("Not set");
    expect(formatChangeValue("")).toBe("Empty");
    expect(formatChangeValue("Open daily")).toBe("Open daily");
    expect(formatChangeValue(42)).toBe("42");
    expect(formatChangeValue(false)).toBe("false");
    expect(formatChangeValue({ primaryCategory: { name: "Dentist" } })).toBe(
      '{\n  "primaryCategory": {\n    "name": "Dentist"\n  }\n}',
    );
  });
  it("formatChangeValue cuts a huge value", () => {
    const out = formatChangeValue("x".repeat(5000));
    expect(out).toHaveLength(2001);
    expect(out.endsWith("…")).toBe(true);
  });
  it("fieldLabel reads field names and attributes", () => {
    expect(fieldLabel("description")).toBe("Description");
    expect(fieldLabel("regularHours")).toBe("Opening hours");
    expect(fieldLabel("attributes/has_wifi")).toBe("Attribute: Has wifi");
  });
  it("formatApprovalTime and ageLabel", () => {
    expect(formatApprovalTime(utc, "2026-10-17T09:12:45.000Z")).toBe("2026-10-17 09:12");
    expect(formatApprovalTime(ist, "2026-10-17T09:12:45.000Z", "w")).toBe("17/10/2026 14:42");
    expect(formatApprovalTime(utc, null)).toBe("");
    const now = Date.parse("2026-10-17T12:00:00.000Z");
    expect(ageLabel("2026-10-17T11:55:00.000Z", now)).toBe("5 m");
    expect(ageLabel("2026-10-17T09:30:00.000Z", now)).toBe("2 h");
    expect(ageLabel("2026-10-15T12:00:00.000Z", now)).toBe("2 d");
    expect(ageLabel("2026-10-17T12:30:00.000Z", now)).toBe("0 m");
    expect(ageLabel(null, now)).toBe("");
  });
});

describe("location filter", () => {
  const a = item({ id: ID1, locationNames: ["Riverside"] });
  const b = item({ id: ID2, type: "changeset", locationNames: ["Hillcrest", "Riverside"] });
  const c = item({ id: ID3, type: "post", locationNames: ["Hillcrest"] });
  it("lists each location once, A to Z", () => {
    expect(locationOptions([a, b, c])).toEqual(["Hillcrest", "Riverside"]);
  });
  it("keeps the items that touch the location, or all when none is named", () => {
    expect(inLocation([a, b, c], "Riverside").map((i) => i.id)).toEqual([ID1, ID2]);
    expect(inLocation([a, b, c], undefined)).toHaveLength(3);
    expect(inLocation([a, b, c], "Nowhere")).toEqual([]);
  });
  it("carries loc in the href", () => {
    expect(approvalsHref({ tab: "reply", ws: "w1", loc: "Riverside" })).toBe("/approvals?tab=reply&ws=w1&loc=Riverside");
  });
});
