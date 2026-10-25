import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { actions, createApiToken } from "@opengmb/core";
import { auditLog, createDb, memberships, organizations, users } from "@opengmb/db";
import { startServer } from "./http";
import { inputSchemaOf } from "./rest";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let orgId: string;
let ownerEmail: string;
let managerEmail: string;
let server: Awaited<ReturnType<typeof startServer>>;
let ownerToken: string;
let readToken: string;
let managerToken: string;

const base = (s = server) => `http://127.0.0.1:${s.port}`;
// Test-only: responses are poked at by path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
async function call(
  token: string | undefined,
  name: string,
  body?: unknown,
  s = server,
): Promise<{ status: number; json: Json; headers: Headers }> {
  const res = await fetch(`${base(s)}/v1/actions/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Json, headers: res.headers };
}
const mcpToolsList = (token: string, s = server) =>
  fetch(`${base(s)}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

async function makeUser(role: "owner" | "manager") {
  const id = `u-${uniq()}`;
  const email = `${id}@example.test`;
  await db.insert(users).values({ id, name: "T", email, twoFactorEnabled: true });
  await db.insert(memberships).values({ orgId, userId: id, role });
  return email;
}

beforeAll(async () => {
  // Generous limits: the shared server must not trip over its own tests (limits get their own servers below).
  server = await startServer(0, {
    db,
    rateLimits: { authFailuresPerMinute: 1000, requestsPerMinute: 10_000, proxyHops: 1 },
  });
  const [org] = await db.insert(organizations).values({ name: `rest-${uniq()}` }).returning();
  orgId = org!.id;
  ownerEmail = await makeUser("owner");
  managerEmail = await makeUser("manager");
  ownerToken = (await createApiToken(db, { email: ownerEmail, name: "rest-owner", mode: "full_autonomy" })).token;
  readToken = (await createApiToken(db, { email: ownerEmail, name: "rest-read", readOnly: true })).token;
  managerToken = (await createApiToken(db, { email: managerEmail, name: "rest-mgr", mode: "full_autonomy" })).token;
});
afterAll(async () => {
  await server.close();
  await sql.end();
});

describe("REST v1: authentication", () => {
  it("no token, a malformed token and an unknown token give 401 with www-authenticate and no internals", async () => {
    for (const t of [undefined, "garbage", "sgmb_doesnotexist"]) {
      const r = await call(t, "reviews.list", {});
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe("Bearer");
      expect(r.headers.get("syngmb-api-version")).toBe("1");
      expect(r.json).toEqual({
        error: { code: "UNAUTHENTICATED", message: "Missing or invalid API token" },
      });
    }
    const list = await fetch(`${base()}/v1/actions`);
    expect(list.status).toBe(401);
  });

  it("11 bad tokens from one address give 429 with retry-after", async () => {
    const s = await startServer(0, { db }); // default limits: 10 bad tokens per minute
    try {
      let last = 0;
      for (let i = 0; i < 11; i++) last = (await call("sgmb_bad", "reviews.list", {}, s)).status;
      expect(last).toBe(429);
      const r = await call("sgmb_bad", "reviews.list", {}, s);
      expect(r.status).toBe(429);
      expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(r.json.error.code).toBe("RATE_LIMITED");
    } finally {
      await s.close();
    }
  });
});

describe("REST v1: the action list", () => {
  it("lists every registry action, and a server given actions.slice(1) lists one fewer (canary)", async () => {
    const res = await fetch(`${base()}/v1/actions`, { headers: { authorization: `Bearer ${ownerToken}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("syngmb-api-version")).toBe("1");
    const list = ((await res.json()) as Json).data.actions as Json[];
    console.log(`[rest] GET /v1/actions lists ${list.length} of ${actions.length} registry actions`);
    expect(actions.length).toBeGreaterThan(0);
    expect(list.map((a) => a.name)).toEqual(actions.map((a) => a.name));
    const first = list[0]!;
    expect(Object.keys(first).sort()).toEqual(["approval", "description", "inputSchema", "kind", "name", "needsPerson"]);
    expect(first.inputSchema).toMatchObject({ type: "object" });

    const trimmed = await startServer(0, { db, actions: actions.slice(1) });
    try {
      const r2 = await fetch(`${base(trimmed)}/v1/actions`, { headers: { authorization: `Bearer ${ownerToken}` } });
      const l2 = ((await r2.json()) as Json).data.actions as Json[];
      expect(l2).toHaveLength(actions.length - 1);
      expect(l2.map((a) => a.name)).not.toContain(actions[0]!.name);
      expect((await call(ownerToken, actions[0]!.name, {}, trimmed)).status).toBe(404);
    } finally {
      await trimmed.close();
    }
  });

  it("every registry action converts to a JSON Schema without throwing", () => {
    let n = 0;
    for (const a of actions) {
      expect(() => inputSchemaOf(a), a.name).not.toThrow();
      n++;
    }
    console.log(`[rest] ${n} of ${actions.length} input schemas converted`);
    expect(n).toBe(actions.length);
    expect(n).toBeGreaterThan(0);
  });
});

describe("REST v1: running actions", () => {
  it("a read returns 200 { data }", async () => {
    const r = await call(ownerToken, "reviews.list", {});
    expect(r.status).toBe(200);
    expect(r.json.data).toHaveProperty("items");
    expect(r.json.data).toHaveProperty("nextCursor");
    const me = await call(ownerToken, "apiTokens.current", {});
    expect(me.json.data).toMatchObject({ user: { email: ownerEmail }, role: "owner" });
    expect(me.json.data.token.name).toBe("rest-owner");
  });

  it("an empty body is the empty input", async () => {
    expect((await call(ownerToken, "workspaces.list")).status).toBe(200);
  });

  it("an unknown action is 404 NOT_FOUND", async () => {
    const r = await call(ownerToken, "nope.nothing", {});
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("NOT_FOUND");
  });

  it("unknown paths and methods are refused", async () => {
    const auth = { authorization: `Bearer ${ownerToken}` };
    expect((await fetch(`${base()}/v1/other`, { headers: auth })).status).toBe(404);
    const getRun = await fetch(`${base()}/v1/actions/reviews.list`, { headers: auth });
    expect(getRun.status).toBe(405);
    expect(getRun.headers.get("allow")).toBe("POST");
    const postList = await fetch(`${base()}/v1/actions`, { method: "POST", headers: auth });
    expect(postList.status).toBe(405);
    expect((await fetch(`${base()}/v1x`, { headers: auth })).status).toBe(404);
  });

  it("bad input is 400 with issues; invalid JSON is 400; a non-object body is 400", async () => {
    const bad = await call(ownerToken, "reviews.list", { limit: "many" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("INVALID_INPUT");
    expect(bad.json.error.issues.length).toBeGreaterThan(0);
    expect(bad.json.error.issues[0]).toHaveProperty("path");
    expect((await call(ownerToken, "reviews.list", "{nope")).json.error.code).toBe("INVALID_JSON");
    expect((await call(ownerToken, "reviews.list", "[1]")).status).toBe(400);
  });

  it("a body over 1 MB is 413", async () => {
    const r = await call(ownerToken, "reviews.list", JSON.stringify({ pad: "x".repeat(1_200_000) }));
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("a read-scope token calling a write action is 403, even for dryRun, and writes nothing", async () => {
    const before = (await db.select().from(auditLog).where(eq(auditLog.orgId, orgId))).length;
    for (const body of [{ name: "ro" }, { name: "ro", dryRun: true }]) {
      const r = await call(readToken, "workspaces.create", body);
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("FORBIDDEN");
    }
    const sub = await call(readToken, "webhooks.subscribe", { url: "https://3.3.3.3/ro" });
    expect(sub.status).toBe(403);
    expect((await db.select().from(auditLog).where(eq(auditLog.orgId, orgId))).length).toBe(before);
    expect((await call(readToken, "workspaces.list", {})).status).toBe(200);
  });

  it("a two_phase write proposes without changing anything, and mcp.proposals.apply applies it", async () => {
    const name = `REST ws ${uniq()}`;
    const proposed = await call(ownerToken, "workspaces.create", { name });
    expect(proposed.status).toBe(200);
    expect(proposed.json.data).toMatchObject({ proposalId: expect.any(String), expiresAt: expect.any(String) });
    expect(proposed.json.data.preview).toBeTruthy();
    const names = (j: Json) => (j.data.workspaces as Json[]).map((w) => w.name);
    expect(names(await call(ownerToken, "workspaces.list", {}).then((r) => r.json))).not.toContain(name);

    const applied = await call(ownerToken, "mcp.proposals.apply", { proposalId: proposed.json.data.proposalId });
    expect(applied.status).toBe(200);
    expect(names(await call(ownerToken, "workspaces.list", {}).then((r) => r.json))).toContain(name);
    const again = await call(ownerToken, "mcp.proposals.apply", { proposalId: proposed.json.data.proposalId });
    expect(again.status).toBe(409);

    // Audit: a REST write is surface "mcp", actor_type "api_token".
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "workspace.create")));
    const mine = rows.filter((r) => (r.after as { name?: string } | null)?.name === name);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ surface: "mcp", actorType: "api_token" });
  });

  it("webhooks.subscribe (own_flow, D1) executes directly for an owner token and returns the secret; unsubscribe deletes it", async () => {
    const hook = `https://3.3.3.3/rest/${uniq()}`;
    const dry = await call(ownerToken, "webhooks.subscribe", { url: hook, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.json.data.dryRun).toBe(true);
    const sub = await call(ownerToken, "webhooks.subscribe", { url: hook, events: ["review.created"], description: "Zapier" });
    expect(sub.status).toBe(200);
    expect(sub.json.data.secret).toMatch(/^whsec_/);
    const id = sub.json.data.subscription.id as string;
    const listed = await call(ownerToken, "webhooks.list", {});
    expect(JSON.stringify(listed.json)).toContain(id);
    expect(JSON.stringify(listed.json)).not.toContain(sub.json.data.secret);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "webhook.subscribe")));
    expect(audits.some((a) => a.surface === "mcp" && a.actorType === "api_token")).toBe(true);
    const del = await call(ownerToken, "webhooks.unsubscribe", { id });
    expect(del.status).toBe(200);
    expect(del.json.data).toEqual({ id });
    expect((await call(ownerToken, "webhooks.unsubscribe", { id })).status).toBe(404);
  });

  it("a manager token (no webhook:manage) cannot subscribe: 403", async () => {
    const r = await call(managerToken, "webhooks.subscribe", { url: "https://3.3.3.3/mgr" });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("FORBIDDEN");
  });

  it("every response carries syngmb-api-version: 1", async () => {
    for (const r of [
      await call(ownerToken, "reviews.list", {}),
      await call(ownerToken, "nope", {}),
      await call(ownerToken, "reviews.list", { limit: "x" }),
      await call(undefined, "reviews.list", {}),
    ]) {
      expect(r.headers.get("syngmb-api-version")).toBe("1");
    }
  });
});

describe("REST v1: rate limit shared with MCP", () => {
  it("2 MCP plus 2 REST requests of one token with a limit of 3 give 429 on the 4th, and that body is the REST error", async () => {
    const s = await startServer(0, { db, rateLimits: { authFailuresPerMinute: 1000, requestsPerMinute: 3, proxyHops: 1 } });
    try {
      const { token } = await createApiToken(db, { email: ownerEmail, name: "rest-rl" });
      expect((await mcpToolsList(token, s)).status).toBe(200);
      expect((await mcpToolsList(token, s)).status).toBe(200);
      expect((await call(token, "workspaces.list", {}, s)).status).toBe(200);
      const fourth = await call(token, "workspaces.list", {}, s);
      expect(fourth.status).toBe(429);
      expect(Number(fourth.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(fourth.json.error.code).toBe("RATE_LIMITED");
      // MCP is limited by the same bucket, and keeps its own body shape.
      const mcp = await mcpToolsList(token, s);
      expect(mcp.status).toBe(429);
      expect(await mcp.json()).toEqual({ error: "rate_limited" });
    } finally {
      await s.close();
    }
  });
});

describe("REST v1: one code path", () => {
  it("rest.ts calls executeToolCall and never executeAction (canary: the pattern matches the real call)", () => {
    const src = readFileSync(new URL("./rest.ts", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).toMatch(/executeToolCall\(/);
    expect(code).not.toMatch(/\bexecuteAction\(/);
    // The canary pattern does find a direct call.
    expect("await executeAction(db, a, n, i)").toMatch(/\bexecuteAction\(/);
  });
});
