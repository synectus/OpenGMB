import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { generate } from "otplib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createApiToken,
  createAuth,
  executeAction,
  loadActor,
  requireAuthenticatedUser,
  verifyAuditChain,
} from "@opengmb/core";
import { apiTokens, auditLog, createDb, memberships } from "@opengmb/db";
import { startServer } from "./http";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);

const BASE = "http://localhost:3000";
const auth = createAuth(db, { secret: "test-secret-test-secret-test-secret-123", baseURL: BASE });
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Drive Better-Auth's handler with a tiny cookie jar, like the browser would. */
async function post(jar: Map<string, string>, path: string, body: unknown) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie },
      body: JSON.stringify(body),
    }),
  );
  for (const line of res.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return { res, json: (await res.json().catch(() => null)) as { totpURI?: string } | null };
}
const sessionOf = (jar: Map<string, string>) =>
  auth.api.getSession({
    headers: new Headers({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }),
  });

async function signUp(opts: { enrollTotp: boolean }) {
  const email = `e2e-${uniq()}@example.test`;
  const password = "correct-horse-battery-staple";
  const jar = new Map<string, string>();
  expect((await post(jar, "/sign-up/email", { name: "E2E", email, password })).res.status).toBe(
    200,
  );
  if (opts.enrollTotp) {
    const enable = await post(jar, "/two-factor/enable", { password });
    const secret = new URL(enable.json!.totpURI!).searchParams.get("secret")!;
    const verify = await post(jar, "/two-factor/verify-totp", {
      code: await generate({ secret, strategy: "totp" }),
    });
    expect(verify.res.status).toBe(200);
  }
  return { email, jar };
}

let server: Awaited<ReturnType<typeof startServer>>;
const mcpUrl = () => `http://127.0.0.1:${server.port}/mcp`;
beforeAll(async () => {
  server = await startServer(0, { db });
});
afterAll(async () => {
  await server.close();
  await sql.end();
});

const rpc = (token?: string) =>
  fetch(mcpUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

describe("end to end: sign-up -> UI action -> token -> MCP", () => {
  it("a workspace created through the executor is visible over MCP and audited once", async () => {
    const { email, jar } = await signUp({ enrollTotp: true });

    // UI path: session -> requireAuthenticatedUser -> loadActor(ui) -> executeAction
    const { userId } = requireAuthenticatedUser(await sessionOf(jar));
    const uiActor = await loadActor(db, { userId, surface: "ui", actorType: "user" });
    const wsName = `E2E workspace ${uniq()}`;
    await executeAction(db, uiActor, "workspaces.create", { name: wsName });

    // Same function `pnpm token:create` calls.
    const { token, row } = await createApiToken(db, { email, name: "e2e", mode: "full_autonomy" });
    expect(token.startsWith("sgmb_")).toBe(true);
    expect(row).not.toHaveProperty("tokenHash");

    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl()), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("workspaces_list");

      const listed = await client.callTool({ name: "workspaces_list", arguments: {} });
      expect(listed.isError).toBeFalsy();
      const names = (listed.structuredContent as { workspaces: { name: string }[] }).workspaces.map(
        (w) => w.name,
      );
      expect(names).toContain(wsName);

      // Writes are two-phase over MCP: the tool call only proposes. A duplicate shows up as a
      // blocking finding, and applying it fails with CONFLICT (errors are isError + { code, message }).
      const dup = await client.callTool({ name: "workspaces_create", arguments: { name: wsName } });
      expect(dup.isError).toBeFalsy();
      const dupProposal = dup.structuredContent as {
        proposalId: string;
        preview: { findings: { ok: boolean } };
      };
      expect(dupProposal.preview.findings.ok).toBe(false);
      const dupApply = await client.callTool({
        name: "mcp_proposals_apply",
        arguments: { proposalId: dupProposal.proposalId },
      });
      expect(dupApply.isError).toBe(true);
      expect(JSON.parse((dupApply.content as { text: string }[])[0]!.text).code).toBe("CONFLICT");

      // Writes over MCP are audited as surface 'mcp' / actor_type 'api_token'.
      const viaMcp = `E2E via mcp ${uniq()}`;
      const proposed = await client.callTool({
        name: "workspaces_create",
        arguments: { name: viaMcp },
      });
      expect(proposed.isError).toBeFalsy();
      const { proposalId } = proposed.structuredContent as { proposalId: string };
      const before = await client.callTool({ name: "workspaces_list", arguments: {} });
      expect(
        (before.structuredContent as { workspaces: { name: string }[] }).workspaces.map(
          (w) => w.name,
        ),
      ).not.toContain(viaMcp);
      const created = await client.callTool({
        name: "mcp_proposals_apply",
        arguments: { proposalId },
      });
      expect(created.isError).toBeFalsy();
    } finally {
      await client.close();
    }

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, uiActor.orgId), eq(auditLog.action, "workspace.create")));
    const ui = audits.filter((a) => (a.after as { name: string }).name === wsName);
    expect(ui).toHaveLength(1);
    expect(ui[0]).toMatchObject({ surface: "ui", actorType: "user", before: null });
    const mcpRows = audits.filter((a) => a.surface === "mcp");
    expect(mcpRows).toHaveLength(1);
    expect(mcpRows[0]).toMatchObject({ actorType: "api_token", actorUserId: userId });

    const cli = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, uiActor.orgId), eq(auditLog.action, "api_token.create")));
    expect(cli).toHaveLength(1);
    expect(cli[0]).toMatchObject({ surface: "cli", actorType: "user" });
    expect(JSON.stringify(cli[0]!.after)).not.toContain("tokenHash");

    const chain = await verifyAuditChain(db, uiActor.orgId);
    expect(chain.ok).toBe(true);
    console.log(`e2e: audit chain ok, ${chain.checked} rows`);

    const [stored] = await db.select().from(apiTokens).where(eq(apiTokens.id, row.id));
    expect(stored!.lastUsedAt).not.toBeNull();
    // One test covers sign-up (password hashing, TOTP), the executor, token creation and several MCP
    // round trips against a real server and database; under a loaded machine it exceeds vitest's
    // 5000 ms default while passing quickly alone. The extra time is headroom, not a hang allowance.
  }, 30_000);

  it("rejects missing, malformed and unknown tokens with 401", async () => {
    expect((await rpc()).status).toBe(401);
    expect((await rpc("garbage")).status).toBe(401);
    expect((await rpc("sgmb_doesnotexist")).status).toBe(401);
    const res = await rpc();
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a revoked token with 401", async () => {
    const { email } = await signUp({ enrollTotp: true });
    const { token, row } = await createApiToken(db, { email });
    expect((await rpc(token)).status).toBe(200);
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, row.id));
    expect((await rpc(token)).status).toBe(401);
  });

  it("revoking through the action (as the owner) makes the token 401; MCP create is forbidden", async () => {
    const { email } = await signUp({ enrollTotp: true });
    const { token, row } = await createApiToken(db, { email });
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl()), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    try {
      const made = await client.callTool({ name: "apiTokens_create", arguments: { name: "x" } });
      expect(made.isError).toBe(true);
      expect(JSON.parse((made.content as { text: string }[])[0]!.text).code).toBe("FORBIDDEN");
      const revoked = await client.callTool({
        name: "apiTokens_revoke",
        arguments: { id: row.id },
      });
      expect(revoked.isError).toBeFalsy();
    } finally {
      await client.close();
    }
    expect((await rpc(token)).status).toBe(401);
  });

  it("rejects a token whose owner has no 2FA with 401", async () => {
    const { email } = await signUp({ enrollTotp: false });
    const { token } = await createApiToken(db, { email });
    expect((await rpc(token)).status).toBe(401);
  });

  it("rejects a token whose owner lost their membership with 401", async () => {
    const { email } = await signUp({ enrollTotp: true });
    const { token, row } = await createApiToken(db, { email });
    expect((await rpc(token)).status).toBe(200);
    await db.delete(memberships).where(eq(memberships.userId, row.ownerUserId));
    expect((await rpc(token)).status).toBe(401);
  });

  it("serves /healthz and rejects GET /mcp", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });
});
