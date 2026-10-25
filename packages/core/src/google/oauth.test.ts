import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  createDb,
  googleConnections,
  googleOauthStates,
  memberships,
  organizations,
  users,
  workspaces,
} from "@opengmb/db";
import type { Db } from "@opengmb/db";
import type { Actor } from "../actor";
import { decryptSecret } from "../crypto";
import { CoreError } from "../errors";
import { executeAction } from "../executor";
import type { Role } from "../permissions";
import {
  BUSINESS_MANAGE_SCOPE,
  completeGoogleConnection,
  getGoogleOAuthConfig,
  setGoogleOAuthOverrides,
} from "./oauth";
import { MOCK_GOOGLE_EMAIL } from "./dev-seed";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------- fake Google
type Fake = {
  scope: string;
  refreshToken: string | null;
  tokenStatus: number;
  revokeStatus: number;
  revokeThrows: boolean;
  userinfo: { sub: string; email: string };
};
const ACCESS_TOKEN = "fake-access-token-AAA";
let fake: Fake;
const challenges = new Map<string, string>(); // code -> PKCE challenge from the auth URL
const tokenRequests: URLSearchParams[] = [];
const revokeRequests: URLSearchParams[] = [];
let server: Server;
let base = "";

const resetFake = () => {
  fake = {
    scope: `openid https://www.googleapis.com/auth/userinfo.email ${BUSINESS_MANAGE_SCOPE}`,
    refreshToken: "fake-refresh-token-RRR",
    tokenStatus: 200,
    revokeStatus: 200,
    revokeThrows: false,
    userinfo: { sub: `sub-${uniq()}`, email: "owner@gbp.example" },
  };
  tokenRequests.length = 0;
  revokeRequests.length = 0;
};

async function readForm(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString());
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (req.url === "/token") {
      const form = await readForm(req);
      tokenRequests.push(form);
      const challenge = challenges.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const ok =
        challenge !== undefined &&
        createHash("sha256").update(verifier).digest("base64url") === challenge &&
        form.get("client_id") === "test-client" &&
        form.get("client_secret") === "test-secret" &&
        form.get("grant_type") === "authorization_code";
      if (fake.tokenStatus !== 200 || !ok) return json(400, { error: "invalid_grant" });
      return json(200, {
        access_token: ACCESS_TOKEN,
        ...(fake.refreshToken ? { refresh_token: fake.refreshToken } : {}),
        scope: fake.scope,
        token_type: "Bearer",
      });
    }
    if (req.url === "/userinfo") {
      if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) return json(401, {});
      return json(200, fake.userinfo);
    }
    if (req.url === "/revoke") {
      revokeRequests.push(await readForm(req));
      if (fake.revokeThrows) return void req.socket.destroy();
      return json(fake.revokeStatus, {});
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await client.end();
});

const useFake = (extra: Parameters<typeof setGoogleOAuthOverrides>[0] = {}) =>
  setGoogleOAuthOverrides({
    clientId: "test-client",
    clientSecret: "test-secret",
    redirectUri: "http://localhost:3000/api/google/callback",
    authUrl: `${base}/auth`,
    tokenUrl: `${base}/token`,
    revokeUrl: `${base}/revoke`,
    userinfoUrl: `${base}/userinfo`,
    ...extra,
  });
afterEach(() => setGoogleOAuthOverrides({}));

// ------------------------------------------------------------------ fixtures
async function makeOrg(d: Db) {
  const [o] = await d
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  return o!.id;
}
async function makeMember(d: Db, orgId: string, role: Role) {
  const id = `u-${uniq()}`;
  await d.insert(users).values({ id, name: "T", email: `${id}@example.test` });
  if (role === "client_approver" || role === "client_viewer") {
    const [w] = await d
      .insert(workspaces)
      .values({ orgId, name: `ws-${uniq()}` })
      .returning();
    await d.insert(memberships).values({ orgId, userId: id, role, workspaceId: w!.id });
  } else {
    await d.insert(memberships).values({ orgId, userId: id, role });
  }
  const actor: Actor = {
    userId: id,
    orgId,
    role,
    workspaceIds: "all",
    surface: "ui",
    actorType: "user",
  };
  return actor;
}
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof CoreError ? e.code : `other:${String(e)}`;
  }
}
async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { reason?: string }).reason ?? `other:${String(e)}`;
  }
}

type Connect = { authUrl: string; expiresAt: string };
/** Run connect as `actor`, then play Google: register an authorization code for its PKCE challenge. */
async function startFlow(actor: Actor) {
  const out = (await executeAction(db, actor, "googleConnections.connect", {})) as Connect;
  const u = new URL(out.authUrl);
  const code = `code-${uniq()}`;
  challenges.set(code, u.searchParams.get("code_challenge")!);
  return { out, u, stateId: u.searchParams.get("state")!, code };
}
const finish = (stateId: string, code: string, sessionUserId: string) =>
  completeGoogleConnection(db, { stateId, code, sessionUserId });
const connectOnce = async (actor: Actor) => {
  const f = await startFlow(actor);
  return finish(f.stateId, f.code, actor.userId);
};
type Listed = {
  configured: boolean;
  sampleAvailable: boolean;
  connections: { id: string; email: string; googleAccountId: string; connectedBy: string }[];
};
const list = (a: Actor) => executeAction(db, a, "googleConnections.list", {}) as Promise<Listed>;
const auditFor = (orgId: string) => db.select().from(auditLog).where(eq(auditLog.orgId, orgId));

// --------------------------------------------------------------------- tests
describe("google connect flow", () => {
  it("builds the auth URL with offline access, consent, PKCE S256 and the business scope", async () => {
    resetFake();
    useFake();
    const owner = await makeMember(db, await makeOrg(db), "owner");
    const { out, u } = await startFlow(owner);
    expect(`${u.origin}${u.pathname}`).toBe(`${base}/auth`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: "test-client",
      redirect_uri: "http://localhost:3000/api/google/callback",
      response_type: "code",
      scope: `openid email ${BUSINESS_MANAGE_SCOPE}`,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      code_challenge_method: "S256",
    });
    expect(u.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ttl = new Date(out.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
  });

  it("defaults: redirect URI is BETTER_AUTH_URL + /api/google/callback, real Google endpoints", () => {
    const prev = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_URL = "https://app.example.test/";
    try {
      const cfg = getGoogleOAuthConfig();
      expect(cfg.redirectUri).toBe("https://app.example.test/api/google/callback");
      expect([cfg.authUrl, cfg.tokenUrl, cfg.revokeUrl, cfg.userinfoUrl]).toEqual([
        "https://accounts.google.com/o/oauth2/v2/auth",
        "https://oauth2.googleapis.com/token",
        "https://oauth2.googleapis.com/revoke",
        "https://openidconnect.googleapis.com/v1/userinfo",
      ]);
    } finally {
      if (prev === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = prev;
    }
  });

  it("happy path: encrypted token round-trips, token never in audit rows or action output", async () => {
    resetFake();
    useFake();
    const orgId = await makeOrg(db);
    const owner = await makeMember(db, orgId, "owner");
    const f = await startFlow(owner);
    const result = await finish(f.stateId, f.code, owner.userId);
    expect(result.created).toBe(true);

    const [row] = await db
      .select()
      .from(googleConnections)
      .where(eq(googleConnections.orgId, orgId));
    expect(row!.refreshTokenEnc).not.toContain(fake.refreshToken!);
    expect(decryptSecret(row!.refreshTokenEnc)).toBe(fake.refreshToken);
    expect(row).toMatchObject({
      googleAccountId: fake.userinfo.sub,
      googleAccountEmail: "owner@gbp.example",
      userId: owner.userId,
    });
    expect(row!.scopes).toContain(BUSINESS_MANAGE_SCOPE);

    const listed = await list(owner);
    expect(listed.connections).toHaveLength(1);
    expect(listed.connections[0]).toMatchObject({
      email: "owner@gbp.example",
      googleAccountId: fake.userinfo.sub,
      connectedBy: owner.userId + "@example.test",
    });

    const audit = await auditFor(orgId);
    expect(audit.map((a) => a.action).sort()).toEqual([
      "google_connection.connect_started",
      "google_connection.create",
    ]);
    const created = audit.find((a) => a.action === "google_connection.create")!;
    expect(created).toMatchObject({ surface: "ui", actorUserId: owner.userId, actorType: "user" });
    expect(created.before).toBeNull();
    expect(Object.keys(created.after as object).sort()).toEqual([
      "connectedByUserId",
      "email",
      "googleAccountId",
      "id",
      "scopes",
    ]);

    // grep-style: no secret anywhere an operator or MCP client can read.
    const everything = JSON.stringify([audit, listed, f.out, result]);
    for (const secret of [fake.refreshToken!, ACCESS_TOKEN, row!.refreshTokenEnc]) {
      expect(everything).not.toContain(secret);
    }
    const state = (
      await db.select().from(googleOauthStates).where(eq(googleOauthStates.id, f.stateId))
    )[0]!;
    expect(everything).not.toContain(state.codeVerifier);
    expect(state.usedAt).not.toBeNull();
  });

  it("connect_started audit row carries the expiry, not the verifier", async () => {
    resetFake();
    useFake();
    const orgId = await makeOrg(db);
    const owner = await makeMember(db, orgId, "owner");
    const f = await startFlow(owner);
    const [a] = await auditFor(orgId);
    expect(a).toMatchObject({
      action: "google_connection.connect_started",
      entityType: "google_oauth_state",
      entityId: f.stateId,
      after: { expiresAt: f.out.expiresAt },
    });
    const [state] = await db
      .select()
      .from(googleOauthStates)
      .where(eq(googleOauthStates.id, f.stateId));
    expect(JSON.stringify(a)).not.toContain(state!.codeVerifier);
  });

  it("reconnecting the same Google account updates the row, with a new token", async () => {
    resetFake();
    useFake();
    const orgId = await makeOrg(db);
    const owner = await makeMember(db, orgId, "owner");
    const first = await connectOnce(owner);
    fake.refreshToken = "fake-refresh-token-SECOND";
    fake.userinfo.email = "renamed@gbp.example";
    const second = await connectOnce(owner);
    expect(second.created).toBe(false);
    expect(second.connectionId).toBe(first.connectionId);

    const rows = await db
      .select()
      .from(googleConnections)
      .where(eq(googleConnections.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(decryptSecret(rows[0]!.refreshTokenEnc)).toBe("fake-refresh-token-SECOND");
    expect(rows[0]!.googleAccountEmail).toBe("renamed@gbp.example");
    const upd = (await auditFor(orgId)).find((a) => a.action === "google_connection.update")!;
    expect((upd.before as { email: string }).email).toBe("owner@gbp.example");
    expect((upd.after as { email: string }).email).toBe("renamed@gbp.example");
    expect(JSON.stringify(upd)).not.toContain("SECOND");
  });

  it("a different Google account in the same org gets its own row", async () => {
    resetFake();
    useFake();
    const orgId = await makeOrg(db);
    const owner = await makeMember(db, orgId, "owner");
    await connectOnce(owner);
    fake.userinfo = { sub: `sub-${uniq()}`, email: "second@gbp.example" };
    await connectOnce(owner);
    expect((await list(owner)).connections.map((c) => c.email).sort()).toEqual([
      "owner@gbp.example",
      "second@gbp.example",
    ]);
  });

  it("the same Google account can be connected in two orgs", async () => {
    resetFake();
    useFake();
    const a = await makeMember(db, await makeOrg(db), "owner");
    const b = await makeMember(db, await makeOrg(db), "owner");
    await connectOnce(a);
    await connectOnce(b);
    expect((await list(a)).connections).toHaveLength(1);
    expect((await list(b)).connections).toHaveLength(1);
  });

  it("a state is single use", async () => {
    resetFake();
    useFake();
    const owner = await makeMember(db, await makeOrg(db), "owner");
    const f = await startFlow(owner);
    await finish(f.stateId, f.code, owner.userId);
    expect(await reasonOf(finish(f.stateId, f.code, owner.userId))).toBe("invalid_state");
    expect(tokenRequests).toHaveLength(1);
  });

  it("an expired state is rejected without calling Google", async () => {
    resetFake();
    useFake();
    const owner = await makeMember(db, await makeOrg(db), "owner");
    const f = await startFlow(owner);
    await db
      .update(googleOauthStates)
      .set({ expiresAt: new Date(Date.now() - 3600 * 1000) })
      .where(eq(googleOauthStates.id, f.stateId));
    expect(await reasonOf(finish(f.stateId, f.code, owner.userId))).toBe("invalid_state");
    expect(tokenRequests).toHaveLength(0);
  });

  it("an unknown state is rejected", async () => {
    resetFake();
    useFake();
    const owner = await makeMember(db, await makeOrg(db), "owner");
    expect(await reasonOf(finish("nope", "c", owner.userId))).toBe("invalid_state");
  });

  it("a state started by user A cannot be completed by user B, and A can still finish it", async () => {
    resetFake();
    useFake();
    const orgId = await makeOrg(db);
    const a = await makeMember(db, orgId, "owner");
    const b = await makeMember(db, orgId, "admin");
    const f = await startFlow(a);
    expect(await reasonOf(finish(f.stateId, f.code, b.userId))).toBe("invalid_state");
    expect(tokenRequests).toHaveLength(0);
    await expect(finish(f.stateId, f.code, a.userId)).resolves.toMatchObject({ created: true });
  });

  it("a user who lost google:manage after starting cannot complete", async () => {
    resetFake();
    useFake();
    const orgId = await makeOrg(db);
    const admin = await makeMember(db, orgId, "admin");
    const f = await startFlow(admin);
    await db
      .update(memberships)
      .set({ role: "manager" })
      .where(and(eq(memberships.userId, admin.userId), eq(memberships.orgId, orgId)));
    expect(await codeOf(finish(f.stateId, f.code, admin.userId))).toBe("FORBIDDEN");
    expect(
      await db.select().from(googleConnections).where(eq(googleConnections.orgId, orgId)),
    ).toHaveLength(0);
  });

  it("no refresh token is rejected and nothing is stored", async () => {
    resetFake();
    useFake();
    const orgId = await makeOrg(db);
    const owner = await makeMember(db, orgId, "owner");
    fake.refreshToken = null;
    expect(await reasonOf(connectOnce(owner))).toBe("missing_refresh_token");
    expect((await list(owner)).connections).toHaveLength(0);
  });

  it("missing business.manage scope is rejected with an actionable message", async () => {
    resetFake();
    useFake();
    const owner = await makeMember(db, await makeOrg(db), "owner");
    fake.scope = "openid https://www.googleapis.com/auth/userinfo.email";
    const f = await startFlow(owner);
    const err = await finish(f.stateId, f.code, owner.userId).catch((e: Error) => e);
    expect(err).toMatchObject({ reason: "missing_scope" });
    expect((err as Error).message).toMatch(/Business Profile box/);
    expect((await list(owner)).connections).toHaveLength(0);
  });

  it("a failed token exchange is rejected", async () => {
    resetFake();
    useFake();
    const owner = await makeMember(db, await makeOrg(db), "owner");
    fake.tokenStatus = 400;
    expect(await reasonOf(connectOnce(owner))).toBe("exchange_failed");
  });

  it("a code that was not issued for this state's PKCE challenge is rejected", async () => {
    resetFake();
    useFake();
    const owner = await makeMember(db, await makeOrg(db), "owner");
    const f = await startFlow(owner);
    expect(await reasonOf(finish(f.stateId, "code-from-elsewhere", owner.userId))).toBe(
      "exchange_failed",
    );
  });
});

describe("googleConnections actions", () => {
  it("NOT_CONFIGURED when credentials are empty", async () => {
    resetFake();
    useFake({ clientId: "", clientSecret: "" });
    const owner = await makeMember(db, await makeOrg(db), "owner");
    const err = await executeAction(db, owner, "googleConnections.connect", {}).catch(
      (e: CoreError) => e,
    );
    expect(err).toMatchObject({
      code: "NOT_CONFIGURED",
      message: "Google OAuth is not configured",
    });
    expect((await list(owner)).configured).toBe(false);
    expect(await codeOf(finish("s", "c", owner.userId))).toBe("NOT_CONFIGURED");
  });

  it("roles: manager lists but cannot connect/disconnect; clients cannot list; admin and owner can", async () => {
    resetFake();
    useFake();
    const orgId = await makeOrg(db);
    const owner = await makeMember(db, orgId, "owner");
    const admin = await makeMember(db, orgId, "admin");
    const manager = await makeMember(db, orgId, "manager");
    const approver = await makeMember(db, orgId, "client_approver");
    const viewer = await makeMember(db, orgId, "client_viewer");
    const c = await connectOnce(owner);
    const id = c.connectionId;
    const run = (a: Actor, name: string, input: object = {}) =>
      codeOf(executeAction(db, a, name, input));

    expect(await run(manager, "googleConnections.list")).toBe("ok");
    expect(await run(manager, "googleConnections.connect")).toBe("FORBIDDEN");
    expect(await run(manager, "googleConnections.disconnect", { id })).toBe("FORBIDDEN");
    for (const client of [approver, viewer]) {
      expect(await run(client, "googleConnections.list")).toBe("FORBIDDEN");
      expect(await run(client, "googleConnections.connect")).toBe("FORBIDDEN");
      expect(await run(client, "googleConnections.disconnect", { id })).toBe("FORBIDDEN");
    }
    expect(await run(admin, "googleConnections.connect")).toBe("ok");
    expect(await run(admin, "googleConnections.list")).toBe("ok");
    expect(await run(admin, "googleConnections.disconnect", { id })).toBe("ok");
    expect(tokenRequests).toHaveLength(1);
  });

  it("disconnect revokes the refresh token at Google and deletes the row", async () => {
    resetFake();
    useFake();
    const orgId = await makeOrg(db);
    const owner = await makeMember(db, orgId, "owner");
    const { connectionId } = await connectOnce(owner);
    const out = await executeAction(db, owner, "googleConnections.disconnect", {
      id: connectionId,
    });
    expect(out).toEqual({ revokedAtGoogle: true, warning: null });
    expect(revokeRequests.map((r) => r.get("token"))).toEqual([fake.refreshToken]);
    expect((await list(owner)).connections).toHaveLength(0);
    const del = (await auditFor(orgId)).find((a) => a.action === "google_connection.delete")!;
    expect(del).toMatchObject({ entityId: connectionId, after: { revokedAtGoogle: true } });
    expect((del.before as { email: string }).email).toBe("owner@gbp.example");
    expect(JSON.stringify(del)).not.toContain(fake.refreshToken!);
  });

  it.each([
    ["Google answers 400", { revokeStatus: 400 }],
    ["the network fails", { revokeThrows: true }],
  ] as const)("if %s, disconnect still removes the row and says so", async (_n, patch) => {
    resetFake();
    useFake();
    const orgId = await makeOrg(db);
    const owner = await makeMember(db, orgId, "owner");
    const { connectionId } = await connectOnce(owner);
    Object.assign(fake, patch);
    const out = (await executeAction(db, owner, "googleConnections.disconnect", {
      id: connectionId,
    })) as { revokedAtGoogle: boolean; warning: string };
    expect(out.revokedAtGoogle).toBe(false);
    expect(out.warning).toContain("https://myaccount.google.com/permissions");
    expect((await list(owner)).connections).toHaveLength(0);
    const del = (await auditFor(orgId)).find((a) => a.action === "google_connection.delete")!;
    expect(del.after).toEqual({ revokedAtGoogle: false });
  });

  it("disconnecting another org's connection is NOT_FOUND and leaves it intact", async () => {
    resetFake();
    useFake();
    const a = await makeMember(db, await makeOrg(db), "owner");
    const b = await makeMember(db, await makeOrg(db), "owner");
    const { connectionId } = await connectOnce(a);
    expect(
      await codeOf(executeAction(db, b, "googleConnections.disconnect", { id: connectionId })),
    ).toBe("NOT_FOUND");
    expect((await list(a)).connections).toHaveLength(1);
    expect((await list(b)).connections).toHaveLength(0);
    expect(revokeRequests).toHaveLength(0);
  });
});

describe("googleConnections.connectSample (the sample Google account)", () => {
  type Sample = { connectionId: string; created: boolean };
  const sample = (a: Actor) => executeAction(db, a, "googleConnections.connectSample", {}) as Promise<Sample>;
  async function inMode<T>(mode: string | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.GOOGLE_BUSINESS_API_MODE;
    if (mode === undefined) delete process.env.GOOGLE_BUSINESS_API_MODE;
    else process.env.GOOGLE_BUSINESS_API_MODE = mode;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_BUSINESS_API_MODE;
      else process.env.GOOGLE_BUSINESS_API_MODE = prev;
    }
  }

  it("mock mode: connects the sample account to the caller's org once, with an audit row each time", async () => {
    await inMode("mock", async () => {
      resetFake();
      useFake({ clientId: "", clientSecret: "" });
      const orgId = await makeOrg(db);
      const owner = await makeMember(db, orgId, "owner");
      const other = await makeMember(db, await makeOrg(db), "owner");
      const listed = await list(owner);
      expect(listed).toMatchObject({ configured: false, sampleAvailable: true });

      const first = await sample(owner);
      expect(first.created).toBe(true);
      const again = await sample(owner);
      expect(again).toEqual({ connectionId: first.connectionId, created: false });

      const after = await list(owner);
      expect(after.connections.map((c) => c.email)).toEqual([MOCK_GOOGLE_EMAIL]);
      expect((await list(other)).connections).toHaveLength(0);
      const rows = (await auditFor(orgId)).filter((a) => a.action === "google_connection.sample_connect");
      expect(rows.map((r) => (r.after as { created: boolean }).created).sort()).toEqual([false, true]);
      expect(rows.every((r) => r.actorUserId === owner.userId && r.surface === "ui")).toBe(true);
    });
  });

  it("unset counts as mock, as everywhere else", async () => {
    await inMode(undefined, async () => {
      useFake();
      const owner = await makeMember(db, await makeOrg(db), "owner");
      expect((await list(owner)).sampleAvailable).toBe(true);
      expect((await sample(owner)).created).toBe(true);
    });
  });

  it("live mode: refused on the server with NOT_CONFIGURED, nothing is written, and the list says it is unavailable", async () => {
    await inMode("live", async () => {
      useFake();
      const orgId = await makeOrg(db);
      const owner = await makeMember(db, orgId, "owner");
      expect(await codeOf(sample(owner))).toBe("NOT_CONFIGURED");
      expect(await list(owner)).toMatchObject({ sampleAvailable: false, connections: [] });
      expect((await auditFor(orgId)).filter((a) => a.action.startsWith("google_connection.sample"))).toHaveLength(0);
    });
  });

  it("roles: owner and admin can; manager and the client roles cannot", async () => {
    await inMode("mock", async () => {
      useFake();
      const orgId = await makeOrg(db);
      const run = async (role: Role) => codeOf(sample(await makeMember(db, orgId, role)));
      expect(await run("manager")).toBe("FORBIDDEN");
      expect(await run("client_approver")).toBe("FORBIDDEN");
      expect(await run("client_viewer")).toBe("FORBIDDEN");
      expect(await run("admin")).toBe("ok");
      expect(await run("owner")).toBe("ok");
    });
  });
});
