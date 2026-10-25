import { describe, expect, it } from "vitest";
import { actions } from "./actions";
import { EXTERNAL_EFFECT_ACTIONS, INTERNAL_ACTIONS, isExternalEffect, personMustApproveMessage } from "./external-effects";

const writes = actions.filter((a) => a.kind === "write").map((a) => a.name);

describe("external effect classification", () => {
  it("puts every write action in exactly one set", () => {
    const unclassified = writes.filter((n) => !EXTERNAL_EFFECT_ACTIONS.has(n) && !INTERNAL_ACTIONS.has(n));
    const both = writes.filter((n) => EXTERNAL_EFFECT_ACTIONS.has(n) && INTERNAL_ACTIONS.has(n));
    expect(writes.length).toBeGreaterThan(100); // fail on zero
    console.log(`write actions: ${writes.length}, external: ${EXTERNAL_EFFECT_ACTIONS.size}, internal: ${INTERNAL_ACTIONS.size}`);
    expect(unclassified, "add to EXTERNAL_EFFECT_ACTIONS or INTERNAL_ACTIONS in external-effects.ts").toEqual([]);
    expect(both).toEqual([]);
  });

  it("names only write actions that exist", () => {
    const all = new Set(writes);
    expect([...EXTERNAL_EFFECT_ACTIONS, ...INTERNAL_ACTIONS].filter((n) => !all.has(n))).toEqual([]);
  });

  it("canaries: a Google write is external, a note is internal", () => {
    expect(isExternalEffect("reviewReplies.publish")).toBe(true);
    expect(isExternalEffect("media.upload")).toBe(true);
    expect(isExternalEffect("reviewNotes.add")).toBe(false);
    expect(INTERNAL_ACTIONS.has("reviewNotes.add")).toBe(true);
  });

  it("the refusal says who must approve and where", () => {
    const m = personMustApproveMessage("proposal", "media.upload");
    expect(m).toContain("A person must approve this in OpenGMB");
    expect(m).toContain("/agents");
    expect(personMustApproveMessage("approval", "posts.approve")).toContain("/approvals");
  });
});
