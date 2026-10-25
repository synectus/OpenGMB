import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { actions, createApiToken, sampleInput, toolNameFor } from "@opengmb/core";
import { auditLog, createDb, mcpProposals, memberships, organizations, users } from "@opengmb/db";
import { startServer } from "./http";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let server: Awaited<ReturnType<typeof startServer>>;
let orgId: string;
let email: string;
beforeAll(async () => {
  // The test makes two calls per write action; the default budget (300 a minute per token) is not the thing under test and
  // would fail the run whenever the action list grows.
  server = await startServer(0, { db, rateLimits: { authFailuresPerMinute: 10, requestsPerMinute: 100_000, proxyHops: 1 } });
  const [org] = await db
    .insert(organizations)
    .values({ name: `scopes-${uniq()}` })
    .returning();
  orgId = org!.id;
  const id = `u-${uniq()}`;
  email = `${id}@example.test`;
  await db.insert(users).values({ id, name: "T", email, twoFactorEnabled: true });
  await db.insert(memberships).values({ orgId, userId: id, role: "owner" });
});
afterAll(async () => {
  await server.close();
  await sql.end();
});

async function connect(token: string) {
  const client = new Client({ name: "scopes", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const rowCounts = async () => ({
  audit: (await db.select().from(auditLog).where(eq(auditLog.orgId, orgId))).length,
  proposals: (await db.select().from(mcpProposals).where(eq(mcpProposals.orgId, orgId))).length,
});

describe("read-only API token over the MCP endpoint", () => {
  it("is FORBIDDEN on every write action, with and without dryRun, and writes nothing", async () => {
    const { token } = await createApiToken(db, { email, readOnly: true });
    const client = await connect(token);
    const before = await rowCounts();
    const writes = actions.filter((a) => a.kind === "write");
    // Denominator: print it, and refuse a registry with no writes (or a filter that matched none).
    console.log(
      `[token-scopes] ${writes.length} write actions of ${actions.length}; each called 2 ways as a read-only token`,
    );
    expect(writes.length).toBeGreaterThan(0);

    const { tools } = await client.listTools();
    const problems: string[] = [];
    let calls = 0;
    for (const action of writes) {
      expect(tools.map((t) => t.name)).toContain(toolNameFor(action.name));
      for (const dryRun of [false, true]) {
        const res = await client.callTool({
          name: toolNameFor(action.name),
          arguments: { ...sampleInput(action), dryRun },
        });
        calls++;
        const text = (res.content as { text: string }[])[0]!.text;
        const body = JSON.parse(text) as { code?: string; message?: string };
        if (!res.isError || body.code !== "FORBIDDEN" || !/read-only/.test(body.message ?? "")) {
          problems.push(`${action.name} dryRun=${dryRun}: ${text.slice(0, 160)}`);
        }
      }
    }
    await client.close();
    expect(problems).toEqual([]);
    expect(calls).toBe(writes.length * 2);
    expect(await rowCounts()).toEqual(before);
  }, 120_000);

  it("control: the same calls from a read and write token are not refused for scope", async () => {
    const { token } = await createApiToken(db, { email, mode: "full_autonomy" });
    const client = await connect(token);
    const res = await client.callTool({
      name: "workspaces_create",
      arguments: { name: `scopes-control-${uniq()}` },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toHaveProperty("proposalId");
    await client.close();
  });

  it("can still read", async () => {
    const { token } = await createApiToken(db, { email, readOnly: true });
    const client = await connect(token);
    const res = await client.callTool({ name: "workspaces_list", arguments: {} });
    expect(res.isError).toBeFalsy();
    await client.close();
  });
});
