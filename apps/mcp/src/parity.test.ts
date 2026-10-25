import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { actions, approvalOf, mcpToolCatalog, type Actor, type AnyAction } from "@opengmb/core";
import { createDb } from "@opengmb/db";
import { createMcpServer, toolNameFor } from "./server";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(() => sql.end());

const actor: Actor = {
  userId: "u",
  orgId: "00000000-0000-0000-0000-000000000000",
  role: "owner",
  workspaceIds: "all",
  surface: "mcp",
  actorType: "api_token",
};

/** Boot the real MCP server over an in-memory transport and return what tools/list reports. */
async function listTools(registry: readonly AnyAction[]) {
  const server = createMcpServer({ db, actor, actions: registry });
  const client = new Client({ name: "parity-test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

/** Names the registry expects that tools/list did not return (and vice versa). Empty = parity. */
function diffNames(registry: readonly AnyAction[], tools: { name: string }[]) {
  const expected = registry.map((a) => toolNameFor(a.name));
  const actual = tools.map((t) => t.name);
  return {
    missing: expected.filter((n) => !actual.includes(n)),
    extra: actual.filter((n) => !expected.includes(n)),
  };
}

describe("MCP tools mirror the action registry", () => {
  it("tools/list matches the registry exactly", async () => {
    expect(actions.length, "registry must not be empty").toBeGreaterThan(0);
    const tools = await listTools(actions);
    console.log(`${actions.length} actions, ${tools.length} tools`);
    expect(diffNames(actions, tools)).toEqual({ missing: [], extra: [] });
    expect(tools.map((t) => t.name).every((n) => /^[a-zA-Z0-9_-]{1,64}$/.test(n))).toBe(true);
    console.log("tools/list:", tools.map((t) => t.name).join(", "));
  });

  it("the docs catalog lists exactly what tools/list returns, with the same inputs", async () => {
    const tools = await listTools(actions);
    const catalog = mcpToolCatalog(actions);
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
    for (const t of tools) {
      const doc = catalog.find((c) => c.name === t.name)!;
      expect(doc.inputs.map((i) => i.name).sort(), t.name).toEqual(Object.keys((t.inputSchema.properties ?? {}) as object).sort());
    }
    console.log(`parity: ${catalog.length} catalog tools matched tools/list`);
  });

  it("the bulk review tool is named exactly reviews_list_unreplied", async () => {
    const tools = await listTools(actions);
    expect(tools.map((t) => t.name)).toContain("reviews_list_unreplied");
    expect(toolNameFor("reviews.list_unreplied")).toBe("reviews_list_unreplied");
    expect(actions.some((a) => a.name === "reviews.list_unreplied")).toBe(true);
    const tool = tools.find((t) => t.name === "reviews_list_unreplied")!;
    expect(Object.keys((tool.inputSchema.properties ?? {}) as object).sort()).toEqual([
      "cursor",
      "includeSkipped",
      "limit",
      "locationIds",
      "ratings",
      "workspaceId",
    ]);
  });

  it("each tool exposes the action's input property names and an output schema", async () => {
    const tools = await listTools(actions);
    for (const action of actions) {
      const tool = tools.find((t) => t.name === toolNameFor(action.name));
      expect(tool, action.name).toBeDefined();
      // Write tools add the transport flag dryRun; their output may also be a proposal / preview.
      const write = action.kind === "write";
      const props = Object.keys((tool!.inputSchema.properties ?? {}) as object).sort();
      expect(props, action.name).toEqual(
        [...Object.keys(action.input.shape), ...(write ? ["dryRun"] : [])].sort(),
      );
      const outProps = Object.keys((tool!.outputSchema?.properties ?? {}) as object).sort();
      expect(outProps, action.name).toEqual(
        [
          ...new Set([
            ...Object.keys(action.output.shape),
            ...(write ? ["dryRun", "expiresAt", "preview", "proposalId"] : []),
          ]),
        ].sort(),
      );
      expect(tool!.description?.startsWith(action.description)).toBe(true);
      expect(tool!.description === action.description, action.name).toBe(!write);
    }
  });

  it("canary: a server missing one action is reported as missing it", async () => {
    const dropped = actions[0]!;
    const tools = await listTools(actions.slice(1));
    const diff = diffNames(actions, tools);
    expect(diff.missing).toEqual([toolNameFor(dropped.name)]);
  });

  it("every write tool accepts dryRun and the three proposal tools exist", async () => {
    const tools = await listTools(actions);
    const writes = actions.filter((a) => a.kind === "write");
    expect(writes.length, "registry must have write actions").toBeGreaterThan(0);
    for (const action of writes) {
      const tool = tools.find((t) => t.name === toolNameFor(action.name))!;
      expect(Object.keys((tool.inputSchema.properties ?? {}) as object), action.name).toContain(
        "dryRun",
      );
      expect(approvalOf(action), action.name).toMatch(/^(two_phase|own_flow)$/);
    }
    for (const reads of actions.filter((a) => a.kind === "read")) {
      const tool = tools.find((t) => t.name === toolNameFor(reads.name))!;
      expect(Object.keys((tool.inputSchema.properties ?? {}) as object)).not.toContain("dryRun");
    }
    for (const name of ["mcp_proposals_apply", "mcp_proposals_cancel", "mcp_proposals_list"]) {
      expect(
        tools.map((t) => t.name),
        name,
      ).toContain(name);
    }
    const twoPhase = writes.filter((a) => approvalOf(a) === "two_phase").length;
    console.log(
      `${writes.length} write tools: ${twoPhase} two_phase, ${writes.length - twoPhase} own_flow`,
    );
    expect(twoPhase).toBeGreaterThan(0);
  });

  it("server.ts reaches the executor only through executeToolCall (canary included)", () => {
    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(src).toMatch(/executeToolCall\(/);
    expect(src).not.toMatch(/\bexecuteAction\(/);
    expect("await executeAction(db)").toMatch(/\bexecuteAction\(/);
  });
});
