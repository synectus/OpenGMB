import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { actions } from "./actions";
import { DESTRUCTIVE_ACTIONS, DIRECTORY_EXCLUDED, NON_DESTRUCTIVE_ACTIONS, destructiveHintFor, directoryActions, toolTitleFor } from "./mcp-tool-meta";
import { isExternalEffect } from "./external-effects";
import { approvalOf } from "./registry";

describe("MCP tool titles", () => {
  it("every action has a non-empty, unique, plain title", () => {
    expect(actions.length).toBeGreaterThan(200); // fail on zero
    const titles = actions.map((a) => toolTitleFor(a.name));
    for (const [i, t] of titles.entries()) {
      expect(t, actions[i]!.name).toMatch(/^[A-Z]/);
      expect(t, actions[i]!.name).not.toMatch(/[._]/);
      expect(t.length, actions[i]!.name).toBeLessThanOrEqual(60);
    }
    const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
    expect(dupes).toEqual([]);
    console.log(`titles: ${titles.length} actions, ${new Set(titles).size} unique`);
  });

  it("the public file names no hosted-only action (they live in mcp-tool-meta-private.ts)", () => {
    const src = readFileSync(new URL("./mcp-tool-meta.ts", import.meta.url), "utf8");
    expect(src.length).toBeGreaterThan(1000); // fail on zero: the file was read
    expect(src.match(/"(billing|integrations|domains|orgInvites|invitations|platformLimits)\.[A-Za-z.]+"/g) ?? []).toEqual([]);
    if (actions.some((a) => a.name === "billing.topups.create")) expect(toolTitleFor("billing.topups.create")).toBe("Billing: create top-up"); // hosted: the private override applies
  });

  it("canaries", () => {
    expect(toolTitleFor("reviewReplies.createDraft")).toBe("Review replies: create draft");
    expect(toolTitleFor("reviews.list_unreplied")).toBe("Reviews: list unreplied");
    expect(toolTitleFor("aiVisibility.runNow")).toBe("AI visibility: run now");
    expect(toolTitleFor("profile.changes.accept")).toBe("Profile: accept changes");
    expect(toolTitleFor("geogrid.byoKey.set")).toBe("Geo-grid: set own API key");
  });
});

const writes = actions.filter((a) => a.kind === "write").map((a) => a.name);

describe("destructiveHint classification", () => {
  it("puts every write action in exactly one set", () => {
    expect(writes.length).toBeGreaterThan(100); // fail on zero
    const unclassified = writes.filter((n) => !DESTRUCTIVE_ACTIONS.has(n) && !NON_DESTRUCTIVE_ACTIONS.has(n));
    const both = writes.filter((n) => DESTRUCTIVE_ACTIONS.has(n) && NON_DESTRUCTIVE_ACTIONS.has(n));
    console.log(`writes: ${writes.length}, destructive: ${DESTRUCTIVE_ACTIONS.size}, not: ${NON_DESTRUCTIVE_ACTIONS.size}`);
    expect(unclassified, "add to DESTRUCTIVE_ACTIONS or NON_DESTRUCTIVE_ACTIONS in mcp-tool-meta.ts").toEqual([]);
    expect(both).toEqual([]);
  });
  it("names only write actions that exist", () => {
    const all = new Set(writes);
    expect([...DESTRUCTIVE_ACTIONS, ...NON_DESTRUCTIVE_ACTIONS].filter((n) => !all.has(n))).toEqual([]);
  });
  it("every external-effect write is destructive", () => {
    expect(writes.filter((n) => isExternalEffect(n) && !DESTRUCTIVE_ACTIONS.has(n))).toEqual([]);
  });
  it("reads are never destructive; canaries", () => {
    for (const a of actions.filter((x) => x.kind === "read")) expect(destructiveHintFor(a), a.name).toBe(false);
    const by = (n: string) => actions.find((a) => a.name === n)!;
    expect(destructiveHintFor(by("reviewReplies.publish"))).toBe(true);
    expect(destructiveHintFor(by("workspaces.delete"))).toBe(true);
    expect(destructiveHintFor(by("mcp.proposals.apply"))).toBe(true);
    expect(destructiveHintFor(by("ai.draftReply"))).toBe(true);
    expect(destructiveHintFor(by("reviewNotes.add"))).toBe(false);
    // Writes that look like drafts but reach Google, send email, expose data, or switch on recurring paid checks.
    for (const n of [
      "reviewReplies.submit", // auto-approve plus auto-publish can send the reply to Google
      "reviewRequests.addRecipients", "reviewRequests.importCsv", // email goes out to recipients added to an active campaign
      "aiVisibility.update", "rankings.track", "geogrid.configs.create", "geogrid.configs.update", "geogrid.settings.update", "reviewTopics.setAuto", // recurring paid checks
      "locationPages.set", // publishes a public page
      "webhooks.subscribe", "webhooks.setStatus", // sends events to an outside URL
    ]) expect(destructiveHintFor(by(n)), n).toBe(true);
    expect(by("geogrid.preview").kind).toBe("read"); // a read that prices a run; it must not spend
    expect(destructiveHintFor(by("geogrid.preview"))).toBe(false);
  });
});

describe("directory profile", () => {
  it("excludes exactly the listed tools, each with a reason, and nothing unknown", () => {
    const names = new Set(actions.map((a) => a.name));
    const listed = Object.keys(DIRECTORY_EXCLUDED);
    expect(listed.length).toBeGreaterThan(0); // fail on zero
    // Hosted-only names are absent from the community registry; the community tree lists none of them.
    expect(listed.filter((n) => !names.has(n))).toEqual([]);
    for (const n of listed) expect(DIRECTORY_EXCLUDED[n], n).toMatch(/\S{3}/);
    const kept = directoryActions(actions);
    expect(kept.length).toBe(actions.length - listed.length);
    console.log(`directory profile: ${actions.length} actions, ${listed.length} excluded, ${kept.length} kept`);
  });
  it("every own_flow external write is excluded (refused to tokens outside dryRun)", () => {
    const refused = actions.filter((a) => approvalOf(a) === "own_flow" && isExternalEffect(a.name)).map((a) => a.name);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.filter((n) => !(n in DIRECTORY_EXCLUDED))).toEqual([]);
  });
  it("canaries: AI image generation is out, the bulk review read is in", () => {
    const kept = directoryActions(actions).map((a) => a.name);
    expect(kept).not.toContain("postImages.generate");
    expect(kept).toContain("reviews.list_unreplied");
    expect(kept).toContain("postImages.renderBranded");
    expect(kept).toContain("postImages.sources");
  });
  it("no kept tool description names an excluded tool", () => {
    const out = Object.keys(DIRECTORY_EXCLUDED);
    const hits = directoryActions(actions).flatMap((a) =>
      out.filter((n) => a.description.includes(n) || a.description.includes(n.replaceAll(".", "_"))).map((n) => `${a.name} -> ${n}`));
    expect(hits).toEqual([]);
  });
});
