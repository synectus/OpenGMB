import { describe, expect, it } from "vitest";
import { actions } from "./actions";
import { mcpToolCatalog, mcpToolsFingerprint } from "./mcpCatalog";
import { approvalOf, toolNameFor } from "./registry";

describe("MCP tool catalog", () => {
  const tools = mcpToolCatalog();
  it("has one entry per registry action, by tool name", () => {
    expect(tools.length).toBeGreaterThan(100); // fail on zero; about 227 today
    expect(tools.map((t) => t.name)).toEqual(actions.map((a) => toolNameFor(a.name)));
    console.log(`mcp-catalog: ${tools.length} tools`);
  });
  it("canary: reviewReplies_createDraft is an own-flow write with a dryRun input", () => {
    const t = tools.find((x) => x.name === "reviewReplies_createDraft")!;
    expect(t).toMatchObject({ kind: "write", approval: "own_flow", group: "reviewReplies" });
    expect(t.inputs.map((i) => i.name)).toContain("dryRun");
  });
  it("labels come from kind and approvalOf, never by hand", () => {
    for (const a of actions) {
      const t = tools.find((x) => x.name === toolNameFor(a.name))!;
      expect(t.kind).toBe(a.kind);
      expect(t.approval).toBe(approvalOf(a));
      expect(t.inputs.some((i) => i.name === "dryRun")).toBe(a.kind === "write");
    }
  });
  it("every tool has a role list and a description", () => {
    for (const t of tools) {
      expect(t.roles.length, t.name).toBeGreaterThan(0);
      expect(t.description.length, t.name).toBeGreaterThan(0);
    }
  });
  it("the fingerprint is stable and moves when a description does", () => {
    expect(mcpToolsFingerprint(tools)).toBe(mcpToolsFingerprint(mcpToolCatalog()));
    const changed = tools.map((t, i) => (i === 0 ? { ...t, description: t.description + "." } : t));
    expect(mcpToolsFingerprint(changed)).not.toBe(mcpToolsFingerprint(tools));
  });
});
